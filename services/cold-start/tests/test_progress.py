from io import StringIO

from cold_start.progress import ConsoleProgressReporter


def test_console_progress_includes_elapsed_time_stage_and_message() -> None:
    stream = StringIO()
    reporter = ConsoleProgressReporter(stream=stream)

    reporter.report("总结", "开始阅读单元 1/2")

    output = stream.getvalue()
    assert output.startswith("[+")
    assert "[总结] 开始阅读单元 1/2" in output
