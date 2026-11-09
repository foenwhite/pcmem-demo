"""Command line entry points for the demo."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from . import paths
from .pipeline import ask_stream, ensure_schema, run_build
from .runtime import AsyncRuntime
from .secrets import load_api
from .server import create_server, set_runtime


def _pg_bin() -> Path | None:
    candidates: list[Path] = []
    found = shutil.which("pg_ctl")
    if found:
        candidates.append(Path(found).resolve().parent)
    for pattern in (
        "/opt/homebrew/opt/postgresql@*/bin",
        "/opt/homebrew/opt/postgresql/bin",
        "/usr/local/opt/postgresql@*/bin",
        "/Applications/Postgres.app/Contents/Versions/*/bin",
    ):
        candidates.extend(sorted(Path("/").glob(pattern.lstrip("/")), reverse=True))
    for candidate in candidates:
        if (candidate / "pg_ctl").exists() and (candidate / "initdb").exists():
            return candidate
    return None


def ensure_postgres() -> None:
    binary_dir = _pg_bin()
    if binary_dir is None:
        raise SystemExit(
            "找不到 PostgreSQL 的 initdb/pg_ctl。\n"
            "安装一个带 pgvector 的 PostgreSQL 16–18，例如：\n"
            "  brew install postgresql@17 pgvector\n"
            "然后把它的 bin 加入 PATH（或安装 Postgres.app）。\n"
            f"演示会使用 {paths.PG_DIR} 里的独立数据目录和 127.0.0.1:{paths.PG_PORT}。"
        )
    env = os.environ.copy()
    env["PATH"] = str(binary_dir) + os.pathsep + env.get("PATH", "")
    env.update({
        "SCI_RAG_LOCAL_PG_DIR": str(paths.PG_DIR),
        "SCI_RAG_LOCAL_PG_PORT": paths.PG_PORT,
        "SCI_RAG_LOCAL_PG_DB": paths.PG_DB,
        "SCI_RAG_LOCAL_PG_USER": paths.PG_USER,
    })
    helper = paths.REPO_DIR / "scripts" / "local_postgres.py"
    if not helper.exists():
        raise SystemExit(f"缺少仓库脚本 {helper}")
    result = subprocess.run(
        [sys.executable, str(helper), "start"],
        cwd=str(paths.DEMO_DIR),
        env=env,
        capture_output=True,
        text=True,
    )
    output = (result.stdout + result.stderr).strip()
    if output:
        print(output)
    if result.returncode != 0:
        raise SystemExit("PostgreSQL 启动失败")


def stop_postgres() -> None:
    binary_dir = _pg_bin()
    if binary_dir is None:
        raise SystemExit("找不到 pg_ctl")
    env = os.environ.copy()
    env["PATH"] = str(binary_dir) + os.pathsep + env.get("PATH", "")
    env.update({
        "SCI_RAG_LOCAL_PG_DIR": str(paths.PG_DIR),
        "SCI_RAG_LOCAL_PG_PORT": paths.PG_PORT,
        "SCI_RAG_LOCAL_PG_DB": paths.PG_DB,
        "SCI_RAG_LOCAL_PG_USER": paths.PG_USER,
    })
    subprocess.run(
        [sys.executable, str(paths.REPO_DIR / "scripts" / "local_postgres.py"), "stop"],
        cwd=str(paths.DEMO_DIR), env=env, check=False,
    )


def command_serve(args: argparse.Namespace) -> int:
    if args.host not in {"127.0.0.1", "localhost", "::1"} and not args.allow_remote:
        raise SystemExit("拒绝绑定非回环地址；确需如此请显式加 --allow-remote，并自行承担密钥风险")
    ensure_postgres()
    runtime = AsyncRuntime()
    set_runtime(runtime)
    runtime.run(ensure_schema(), timeout=120)
    httpd = create_server(args.host, args.port)
    url = f"http://{args.host}:{args.port}/"
    print(f"PC-Mem demo: {url}")
    print(f"语料: {paths.SAMPLE_DIR}")
    print(f"密钥: {paths.SECRETS_PATH}（0600；只在服务端读取）")
    print("Ctrl-C 停止")
    if args.open:
        import webbrowser

        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n停止中…")
    finally:
        httpd.server_close()
        try:
            from sci_rag.db import dispose_engine

            runtime.run(dispose_engine(), timeout=30)
        except Exception:
            pass
        runtime.shutdown()
    return 0


def _printer(phase: str, message: str, percent: int | None = None, **extra: object) -> None:
    suffix = f" [{percent:3d}%]" if isinstance(percent, int) else ""
    print(f"[{phase}]{suffix} {message}")


def command_build(args: argparse.Namespace) -> int:
    ensure_postgres()
    runtime = AsyncRuntime()
    runtime.run(ensure_schema(), timeout=120)
    try:
        result = runtime.run(run_build(_printer, with_communities=args.with_communities), timeout=None)
    finally:
        try:
            from sci_rag.db import dispose_engine

            runtime.run(dispose_engine(), timeout=30)
        except Exception:
            pass
        runtime.shutdown()
    print(json.dumps(result.get("counts", {}), ensure_ascii=False, indent=2))
    for warning in result.get("warnings", []):
        print(f"警告: {warning}")
    return 0


def command_ask(args: argparse.Namespace) -> int:
    if load_api() is None:
        raise SystemExit("还没有保存模型 API；请先在 Web UI 的设置里填写")
    ensure_postgres()
    runtime = AsyncRuntime()
    runtime.run(ensure_schema(), timeout=120)

    async def run() -> None:
        async for event in ask_stream(
            args.question, project_id=args.project, external_only=args.external_only,
            use_hyde=args.hyde,
        ):
            kind = event["type"]
            data = event["data"]
            if kind == "delta":
                sys.stdout.write(data.get("text", ""))
                sys.stdout.flush()
            elif kind == "retrieval_done":
                print("\n— 检索 —")
                for trace in data.get("traces", []):
                    print(f"  {trace['stage']}: {trace['status']} "
                          f"{trace['candidate_count']} 候选 / {trace['duration_ms']}ms")
            elif kind == "citations":
                citations = data.get("citations", [])
                if citations:
                    print("\n— 来源 —")
                    for citation in citations:
                        mark = "✓" if citation.get("cited") else "·"
                        print(f"  {mark} [{citation['index']}] {citation['title']}"
                              f" {citation.get('section_path') or ''}")
            elif kind == "error":
                print(f"\n错误: {data.get('message')}")
            elif kind == "done":
                print()

    try:
        runtime.run(run(), timeout=None)
    finally:
        try:
            from sci_rag.db import dispose_engine

            runtime.run(dispose_engine(), timeout=30)
        except Exception:
            pass
        runtime.shutdown()
    return 0


def command_status(args: argparse.Namespace) -> int:
    ensure_postgres()
    runtime = AsyncRuntime()
    try:
        runtime.run(ensure_schema(), timeout=120)
        from . import views

        state = runtime.run(views.state(), timeout=60)
        print(json.dumps(state, ensure_ascii=False, indent=2))
    finally:
        runtime.shutdown()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pcmem-demo", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="启动 Web UI")
    serve.add_argument("--host", default=paths.DEFAULT_HOST)
    serve.add_argument("--port", type=int, default=paths.DEFAULT_PORT)
    serve.add_argument("--allow-remote", action="store_true")
    serve.add_argument("--open", action="store_true")
    serve.set_defaults(func=command_serve)

    build = sub.add_parser("build", help="用固定语料重建数据库与图谱")
    build.add_argument("--with-communities", action="store_true",
                       help="也生成社区摘要（多次模型调用，较慢）")
    build.set_defaults(func=command_build)

    ask = sub.add_parser("ask", help="命令行提一个问题，走同一回答路径")
    ask.add_argument("question")
    ask.add_argument("--project", default=None)
    ask.add_argument("--external-only", action="store_true")
    ask.add_argument("--hyde", action="store_true", help="启用 HyDE（多一次模型调用）")
    ask.set_defaults(func=command_ask)

    status = sub.add_parser("status", help="打印当前计数与构建报告")
    status.set_defaults(func=command_status)

    stop = sub.add_parser("pg-stop", help="停止演示用的 PostgreSQL")
    stop.set_defaults(func=lambda args: stop_postgres() or 0)

    args = parser.parse_args(argv)
    if getattr(args, "func", None) is None:
        parser.print_help()
        return 2
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
