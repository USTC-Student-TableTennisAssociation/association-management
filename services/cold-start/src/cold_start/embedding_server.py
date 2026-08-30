"""为数据库导入和在线搜索复用同一个常驻 BGE-M3 模型。"""

from __future__ import annotations

import json
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from cold_start.progress import ConsoleProgressReporter
from cold_start.region_tree.runtime import BgeM3Embedder

DEFAULT_EMBEDDING_MODEL_REVISION = "huggingface-main"


class BgeM3EmbeddingService:
    """串行访问模型；HTTP 线程只负责连接，不并发操作 torch 模型。"""

    def __init__(
        self,
        model_name: str,
        model_revision: str = DEFAULT_EMBEDDING_MODEL_REVISION,
    ) -> None:
        self.model_name = model_name
        self.model_revision = model_revision
        self.embedder = BgeM3Embedder(model_name, ConsoleProgressReporter())
        self.lock = threading.Lock()

    def encode(self, texts: list[str]) -> list[list[float]]:
        if not texts or len(texts) > 256:
            raise ValueError("texts 必须包含 1 到 256 个字符串")
        if any(not isinstance(text, str) or not text.strip() for text in texts):
            raise ValueError("texts 不能包含空字符串")
        if any(len(text) > 20_000 for text in texts):
            raise ValueError("单个 embedding 文本不能超过 20,000 字符")
        with self.lock:
            return self.embedder._encode(texts)


def _handler(service: BgeM3EmbeddingService) -> type[BaseHTTPRequestHandler]:
    class EmbeddingHandler(BaseHTTPRequestHandler):
        server_version = "SydarisBgeM3/1"

        def do_GET(self) -> None:
            if self.path != "/health":
                self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            self._json(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    "model": service.model_name,
                    "model_revision": service.model_revision,
                    "dimension": 1024,
                    "loaded": service.embedder.model is not None,
                },
            )

        def do_POST(self) -> None:
            if self.path != "/embed":
                self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("content-length", "0"))
                if length <= 0 or length > 4_000_000:
                    raise ValueError("请求正文大小无效")
                payload: Any = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict) or not isinstance(payload.get("texts"), list):
                    raise ValueError("请求必须包含 texts 数组")
                vectors = service.encode(payload["texts"])
                self._json(
                    HTTPStatus.OK,
                    {
                        "model": service.model_name,
                        "model_revision": service.model_revision,
                        "dimension": len(vectors[0]),
                        "vectors": vectors,
                    },
                )
            except (ValueError, json.JSONDecodeError) as error:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            except Exception as error:  # pragma: no cover - 运行时模型/设备错误
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})

        def log_message(self, format: str, *args: object) -> None:
            print(f"[embedding-http] {self.address_string()} {format % args}")

        def _json(self, status: HTTPStatus, payload: dict[str, object]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return EmbeddingHandler


def serve_embeddings(*, host: str, port: int, model_name: str, model_revision: str) -> None:
    service = BgeM3EmbeddingService(model_name, model_revision)
    server = ThreadingHTTPServer((host, port), _handler(service))
    print(
        f"BGE-M3 embedding service listening on http://{host}:{port}; "
        f"model={model_name}; revision={model_revision}"
    )
    server.serve_forever()
