"""MinerU execution providers for local CLI and authenticated HTTP API parsing."""

from __future__ import annotations

import base64
import importlib.metadata
import json
import mimetypes
import os
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit, urlunsplit

import httpx


@dataclass(frozen=True)
class MinerUOptions:
    backend: str
    effort: str
    method: str
    image_analysis: bool


@dataclass(frozen=True)
class MinerUExecution:
    provider: str
    version: str
    backend: str


class MinerUProvider(Protocol):
    @property
    def cache_key(self) -> str: ...

    def accelerator_description(self) -> str: ...

    def execute(
        self,
        source_path: Path,
        raw_directory: Path,
        *,
        progress: Callable[[str], None],
    ) -> MinerUExecution: ...


class LocalMinerUProvider:
    def __init__(self, options: MinerUOptions) -> None:
        self.options = options

    @property
    def cache_key(self) -> str:
        image_mode = "images" if self.options.image_analysis else "no-images"
        return (
            f"mineru-local-{self.options.backend}-{self.options.effort}-"
            f"{self.options.method}-{image_mode}"
        )

    def accelerator_description(self) -> str:
        try:
            import torch
        except ImportError:
            return "未知（当前环境未安装 Torch）"
        if torch.cuda.is_available():
            name = torch.cuda.get_device_name(0)
            return f"cuda:0（{name}，CUDA {torch.version.cuda}）"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
        return "cpu"

    def execute(
        self,
        source_path: Path,
        raw_directory: Path,
        *,
        progress: Callable[[str], None],
    ) -> MinerUExecution:
        executable = shutil.which("mineru")
        if executable is None:
            raise RuntimeError("未找到 mineru 命令；请先在 cold-start 目录执行 uv sync")
        raw_directory.mkdir(parents=True, exist_ok=False)
        log_path = raw_directory.parent / "mineru.log"
        command = self.command(executable, source_path, raw_directory)
        progress(f"MinerU 命令：{subprocess.list2cmdline(command)}")
        return_code = self._stream_process(command, log_path, progress=progress)
        if return_code != 0:
            raise RuntimeError(
                f"MinerU 解析失败（退出码 {return_code}），完整日志：{log_path}"
            )
        try:
            version = importlib.metadata.version("mineru")
        except importlib.metadata.PackageNotFoundError:
            version = "unknown"
        return MinerUExecution("local", version, self.options.backend)

    def command(self, executable: str, source_path: Path, raw_directory: Path) -> list[str]:
        return [
            executable,
            "-p",
            str(source_path),
            "-o",
            str(raw_directory),
            "-b",
            self.options.backend,
            "--effort",
            self.options.effort,
            "-m",
            self.options.method,
            "--image-analysis",
            str(self.options.image_analysis).lower(),
        ]

    @staticmethod
    def _stream_process(
        command: list[str],
        log_path: Path,
        *,
        progress: Callable[[str], None],
    ) -> int:
        environment = os.environ.copy()
        environment.setdefault("PYTHONUTF8", "1")
        environment.setdefault("PYTHONIOENCODING", "utf-8")
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=environment,
            )
            assert process.stdout is not None
            for line in process.stdout:
                log.write(line)
                log.flush()
                message = line.strip()
                if message:
                    progress(message)
            return process.wait()


@dataclass(frozen=True)
class MinerUApiSettings:
    base_url: str
    api_key: str
    model: str
    timeout_seconds: float
    file_parse_url: str | None = None

    @classmethod
    def from_environment(cls) -> MinerUApiSettings:
        base_url = os.getenv("MINERU_API_BASE_URL", "").strip()
        api_key = (os.getenv("MINERU_API_KEY") or os.getenv("AI_API_KEY") or "").strip()
        model = os.getenv("MINERU_MODEL", "mineru").strip()
        if not base_url:
            raise ValueError("API Provider 缺少 MINERU_API_BASE_URL")
        if not api_key:
            raise ValueError("API Provider 缺少 MINERU_API_KEY 或 AI_API_KEY")
        if not model:
            raise ValueError("MINERU_MODEL 不能为空")
        raw_timeout = os.getenv("MINERU_API_TIMEOUT_SECONDS", "1800")
        try:
            timeout_seconds = float(raw_timeout)
        except ValueError as error:
            raise ValueError("MINERU_API_TIMEOUT_SECONDS 必须是数字") from error
        if timeout_seconds <= 0:
            raise ValueError("MINERU_API_TIMEOUT_SECONDS 必须大于 0")
        return cls(
            base_url=base_url,
            api_key=api_key,
            model=model,
            timeout_seconds=timeout_seconds,
            file_parse_url=os.getenv("MINERU_API_FILE_PARSE_URL") or None,
        )

    def resolved_file_parse_url(self) -> str:
        if self.file_parse_url:
            return self.file_parse_url.strip()
        parts = urlsplit(self.base_url)
        if not parts.scheme or not parts.netloc:
            raise ValueError("MINERU_API_BASE_URL 必须是完整的 HTTP(S) URL")
        return urlunsplit((parts.scheme, parts.netloc, "/mineru/file_parse", "", ""))


class ApiMinerUProvider:
    def __init__(
        self,
        options: MinerUOptions,
        settings: MinerUApiSettings,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.options = options
        self.settings = settings
        self.transport = transport

    @property
    def cache_key(self) -> str:
        host = urlsplit(self.settings.resolved_file_parse_url()).netloc
        return f"mineru-api-{self.settings.model}-{host}-multipart-v1"

    def accelerator_description(self) -> str:
        host = urlsplit(self.settings.resolved_file_parse_url()).netloc
        return f"remote-api（{host}，model={self.settings.model}）"

    def execute(
        self,
        source_path: Path,
        raw_directory: Path,
        *,
        progress: Callable[[str], None],
    ) -> MinerUExecution:
        raw_directory.mkdir(parents=True, exist_ok=False)
        log_path = raw_directory.parent / "mineru.log"
        endpoint = self.settings.resolved_file_parse_url()
        progress(f"MinerU API：上传 {source_path.name} 至 {urlsplit(endpoint).netloc}")
        mime_type = mimetypes.guess_type(source_path.name)[0] or "application/octet-stream"
        try:
            with source_path.open("rb") as source, httpx.Client(
                timeout=httpx.Timeout(self.settings.timeout_seconds),
                transport=self.transport,
            ) as client:
                response = client.post(
                    endpoint,
                    headers={"Authorization": f"Bearer {self.settings.api_key}"},
                    files={"files": (source_path.name, source, mime_type)},
                    data={
                        "return_md": "true",
                        "return_content_list": "true",
                        "return_images": "true",
                        "response_format_zip": "false",
                    },
                )
        except httpx.HTTPError as error:
            self._write_log(log_path, endpoint, error=str(error))
            raise RuntimeError(
                f"MinerU API 连接失败：{type(error).__name__}: {error}；完整日志：{log_path}"
            ) from error
        if not response.is_success:
            detail = response.text.replace("\n", " ").strip()[:2_000]
            self._write_log(log_path, endpoint, status=response.status_code, error=detail)
            raise RuntimeError(
                f"MinerU API 返回 HTTP {response.status_code}：{detail or '无错误正文'}；"
                f"完整日志：{log_path}"
            )
        try:
            payload = response.json()
        except ValueError as error:
            self._write_log(
                log_path,
                endpoint,
                status=response.status_code,
                error="响应不是 JSON",
            )
            raise RuntimeError(f"MinerU API 响应不是 JSON；完整日志：{log_path}") from error
        try:
            execution = self._materialize_response(source_path, raw_directory, payload)
        except (OSError, ValueError) as error:
            self._write_log(
                log_path,
                endpoint,
                status=response.status_code,
                error=f"响应适配失败：{error}",
            )
            raise RuntimeError(
                f"MinerU API 响应无法转换为 Sydaris ParsedDocument：{error}；"
                f"完整日志：{log_path}"
            ) from error
        self._write_log(log_path, endpoint, status=response.status_code, execution=execution)
        progress(f"MinerU API 解析完成：provider=api，version={execution.version}")
        return execution

    def _materialize_response(
        self,
        source_path: Path,
        raw_directory: Path,
        payload: object,
    ) -> MinerUExecution:
        envelope = self._record(payload, "响应顶层")
        if isinstance(envelope.get("data"), dict):
            envelope = self._record(envelope["data"], "响应 data")
        results = self._record(envelope.get("results"), "响应 results")
        if len(results) != 1:
            raise ValueError(f"MinerU API 应返回恰好一个文件结果，实际为 {len(results)}")
        result_name, raw_result = next(iter(results.items()))
        result = self._record(raw_result, f"文件结果 {result_name}")
        content_list = result.get("content_list")
        if isinstance(content_list, str):
            try:
                content_list = json.loads(content_list)
            except json.JSONDecodeError as error:
                raise ValueError("MinerU API content_list 不是有效 JSON") from error
        if not isinstance(content_list, list):
            raise ValueError(
                "MinerU API 未返回 content_list；服务端必须支持 return_content_list=true"
            )
        result_directory = raw_directory / source_path.stem / "api"
        result_directory.mkdir(parents=True, exist_ok=False)
        content_list_path = result_directory / f"{source_path.stem}_content_list.json"
        content_list_path.write_text(
            json.dumps(content_list, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        markdown = result.get("md_content")
        if isinstance(markdown, str):
            (result_directory / f"{source_path.stem}.md").write_text(markdown, encoding="utf-8")
        images = result.get("images")
        if images is not None:
            image_map = self._record(images, "响应 images")
            image_directory = result_directory / "images"
            image_directory.mkdir(exist_ok=True)
            for raw_name, raw_data in image_map.items():
                name = Path(str(raw_name)).name
                if not name or name != str(raw_name):
                    raise ValueError(f"MinerU API 返回了不安全的图片文件名：{raw_name}")
                if not isinstance(raw_data, str) or "," not in raw_data:
                    raise ValueError(f"MinerU API 图片 {name} 不是 data URI")
                header, encoded = raw_data.split(",", 1)
                if ";base64" not in header:
                    raise ValueError(f"MinerU API 图片 {name} 不是 base64 data URI")
                try:
                    decoded = base64.b64decode(encoded, validate=True)
                except ValueError as error:
                    raise ValueError(f"MinerU API 图片 {name} 的 base64 无效") from error
                (image_directory / name).write_bytes(decoded)
        version = str(envelope.get("version") or "unknown")
        backend = str(envelope.get("backend") or self.options.backend)
        (raw_directory / "api-response-metadata.json").write_text(
            json.dumps(
                {
                    "provider": "api",
                    "model": self.settings.model,
                    "version": version,
                    "backend": backend,
                    "result_name": str(result_name),
                    "returned_markdown": isinstance(markdown, str),
                    "returned_content_list": True,
                    "returned_image_count": len(images) if isinstance(images, dict) else 0,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        return MinerUExecution("api", version, backend)

    @staticmethod
    def _record(value: object, label: str) -> dict[str, object]:
        if not isinstance(value, dict):
            raise ValueError(f"MinerU API {label} 必须是对象")
        return {str(key): item for key, item in value.items()}

    def _write_log(
        self,
        path: Path,
        endpoint: str,
        *,
        status: int | None = None,
        error: str | None = None,
        execution: MinerUExecution | None = None,
    ) -> None:
        payload = {
            "provider": "api",
            "endpoint_host": urlsplit(endpoint).netloc,
            "model": self.settings.model,
            "status": status,
            "error": error,
            "version": execution.version if execution else None,
            "backend": execution.backend if execution else self.options.backend,
        }
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def create_mineru_provider(options: MinerUOptions) -> MinerUProvider:
    configured = os.getenv("COLD_START_MINERU_PROVIDER", "auto").strip().lower()
    if configured not in {"auto", "api", "local"}:
        raise ValueError("COLD_START_MINERU_PROVIDER 只支持 auto、api、local")
    if configured == "api" or (
        configured == "auto" and bool(os.getenv("MINERU_API_BASE_URL", "").strip())
    ):
        return ApiMinerUProvider(options, MinerUApiSettings.from_environment())
    return LocalMinerUProvider(options)
