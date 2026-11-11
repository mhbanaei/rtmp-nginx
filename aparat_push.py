#!/usr/bin/env python3
"""Restream.42 - Aparat / RTMP push agent.

Aparat's ingest is different from YouTube/Twitch/Kick: it expects a complete
event URL (``rtmp://rtmp.cdn.asset.aparat.com:443/event/<id>?s=<token>``) and
is unforgiving about reconnects, so the push is handled here instead of inside
the main Node process. The agent:

  * wraps ffmpeg with the right Aparat/RTMP flags,
  * watches FFmpeg progress and reports consumed bytes to the panel (USAGE),
  * detects frozen output and restarts FFmpeg automatically,
  * stops the child process on SIGINT/SIGTERM.

Protocol written to stdout (one record per line, consumed by server/relays.js):
    USAGE <bytes_delta>
    BITRATE <kbit_per_second>
    STATE <starting|running|reconnecting|stopped>
    LOG <message>
"""

from __future__ import annotations

import argparse
import os
import re
import signal
import subprocess
import sys
import threading
import time

STOP = threading.Event()
CURRENT = None
CURRENT_LOCK = threading.Lock()

ERROR_PATTERNS = (
    "connection refused",
    "server error",
    "broken pipe",
    "connection reset",
    "i/o error",
    "error opening",
    "operation not permitted",
    "conversion failed",
    "failed to connect",
    "could not connect",
)
FREEZE_SECONDS = 30.0
RECONNECT_DELAY = 3.0


def emit(line: str) -> None:
    try:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def log(message: str) -> None:
    emit("LOG " + str(message).replace("\n", " ")[:400])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Restream.42 RTMP push agent")
    parser.add_argument("--input", required=True, help="local ingest RTMP url")
    parser.add_argument("--output", required=True, help="destination RTMP url")
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG_PATH", "ffmpeg"))
    parser.add_argument("--audio-aac", action="store_true", help="re-encode audio to AAC (compatibility)")
    parser.add_argument("--compat", action="store_true", help="alias for --audio-aac")
    return parser.parse_args()


def build_command(args: argparse.Namespace) -> list[str]:
    cmd = [
        args.ffmpeg,
        "-hide_banner",
        "-loglevel", "warning",
        "-nostdin",
        "-progress", "pipe:1",
        "-stats_period", "1",
        "-rtmp_live", "live",
        "-i", args.input,
        "-c", "copy",
    ]
    if args.audio_aac or args.compat:
        cmd += ["-c:a", "aac", "-b:a", "160k", "-ar", "44100"]
    cmd += ["-flvflags", "no_duration_filesize", "-f", "flv", args.output]
    return cmd


def terminate(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
    except Exception:
        pass
    try:
        proc.wait(timeout=6)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def run_once(args: argparse.Namespace) -> int:
    global CURRENT

    cmd = build_command(args)
    emit("STATE starting")
    log("starting ffmpeg push")
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError:
        log("ffmpeg was not found; set FFMPEG_PATH")
        emit("STATE stopped")
        return 127
    except Exception as exc:  # noqa: BLE001
        log(f"failed to start ffmpeg: {exc}")
        emit("STATE stopped")
        return 1

    with CURRENT_LOCK:
        CURRENT = proc

    last_size = 0
    last_progress = time.time()
    running_sent = False

    def read_stdout() -> None:
        nonlocal last_size, last_progress, running_sent
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.strip()
            if not line:
                continue
            last_progress = time.time()
            if line.startswith("total_size="):
                value = line.split("=", 1)[1].strip()
                if value.isdigit():
                    size = int(value)
                    if size >= last_size and size - last_size > 0:
                        emit(f"USAGE {size - last_size}")
                    last_size = size
                    if not running_sent and size > 0:
                        running_sent = True
                        emit("STATE running")
            elif line.startswith("bitrate="):
                match = re.search(r"([\d.]+)\s*kbits/s", line)
                if match:
                    emit(f"BITRATE {int(float(match.group(1)))}")

    def read_stderr() -> None:
        assert proc.stderr is not None
        for raw in proc.stderr:
            line = raw.strip()
            if not line:
                continue
            log(line)
            if any(pattern in line.lower() for pattern in ERROR_PATTERNS):
                # FFmpeg normally exits after a fatal connection error; the
                # supervisor below handles the restart.
                pass

    threading.Thread(target=read_stdout, daemon=True).start()
    threading.Thread(target=read_stderr, daemon=True).start()

    while proc.poll() is None:
        if STOP.is_set():
            terminate(proc)
            break
        if time.time() - last_progress > FREEZE_SECONDS:
            log("no media progress for 30s; restarting ffmpeg")
            terminate(proc)
            break
        time.sleep(0.5)

    code = proc.wait()
    with CURRENT_LOCK:
        CURRENT = None
    return code


def main() -> int:
    args = parse_args()
    if not re.match(r"^rtmps?://", args.output, re.I):
        log("destination must start with rtmp:// or rtmps://")
        return 2

    def handle_signal(signum, frame):  # noqa: ANN001
        STOP.set()
        with CURRENT_LOCK:
            terminate(CURRENT)

    try:
        signal.signal(signal.SIGINT, handle_signal)
        signal.signal(signal.SIGTERM, handle_signal)
    except Exception:
        pass

    attempt = 0
    while not STOP.is_set():
        code = run_once(args)
        if STOP.is_set():
            break
        attempt += 1
        emit("STATE reconnecting")
        log(f"ffmpeg exited with code {code}; reconnecting in {int(RECONNECT_DELAY)}s")
        STOP.wait(RECONNECT_DELAY)

    emit("STATE stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
