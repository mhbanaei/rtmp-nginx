import threading
import subprocess
import logging
import time
from flask import Flask, request

app = Flask(__name__)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

# === پیکربندی کاربران و خروجی‌ها ===
VALID_KEYS = {
    "live1": ["user1_key"],
    "live2": ["user2_key"],
}
OUTPUT_URLS = {
    "user1_key": "rtmp://rtmp.cdn.asset.aparat.com:443/event/YourStream_Key",
    "user2_key": "rtmp://rtmp.cdn.asset.aparat.com:443/event/YourStream_Key",
}
# =====================================

streaming_procs = {}
streaming_threads = {}
stop_events = {}
proc_lock = threading.Lock()

def get_output_url(key):
    return OUTPUT_URLS.get(key)

@app.route('/auth', methods=['POST'])
def auth():
    server = request.args.get('server', '')
    key = request.form.get('name', '')
    if server in VALID_KEYS and key in VALID_KEYS[server]:
        logging.info(f"Auth OK: server={server}, key={key}")
        start_stream(server, key)
        return "OK", 200
    logging.warning(f"Auth Failed: server={server}, key={key}")
    return "Forbidden", 403

@app.route('/stop', methods=['POST'])
def stop():
    key = request.args.get('name', '') or request.form.get('name', '')
    logging.info(f"Stopping stream for key={key}")
    stop_stream(key)
    return "Stopped", 200

def start_stream(server, key):
    with proc_lock:
        if key in streaming_threads:
            return
        stop_event = threading.Event()
        stop_events[key] = stop_event
        thread = threading.Thread(
            target=run_ffmpeg_monitor,
            args=(server, key, stop_event),
            daemon=True
        )
        streaming_threads[key] = thread
        thread.start()
        logging.info(f"Started ffmpeg thread for {server}:{key}")

def stop_stream(key):
    with proc_lock:
        ev = stop_events.pop(key, None)
        if ev:
            ev.set()
        proc = streaming_procs.pop(key, None)
        if proc:
            proc.terminate()
        streaming_threads.pop(key, None)

def run_ffmpeg_monitor(server, key, stop_event):
    input_url = f"rtmp://127.0.0.1/{server}/{key}"
    output_url = get_output_url(key)
    if not output_url:
        logging.error(f"No output URL for key={key}")
        return

    while not stop_event.is_set():
        cmd = [
            r"C:\ffmpeg\bin\ffmpeg.exe",

            "-rtmp_live", "live",
            "-i", input_url,

            "-c:v", "copy",
            "-c:a", "copy",

            "-f", "flv",
            output_url
        ]
        logging.info(f"Running ffmpeg for {server}:{key}")
        proc = subprocess.Popen(cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, universal_newlines=True)
        with proc_lock:
            streaming_procs[key] = proc

        disconnected = False
        last_time = None
        stable_count = 0
        last_log_time = time.time()  # زمان آخرین لاگ

        for line in proc.stderr:
            if stop_event.is_set():
                break
            line = line.strip()
            if not line:
                continue

            # کاهش بار CPU
            time.sleep(0.05)

            if "Connection refused" in line or "Server error" in line or "Immediate exit requested" in line:
                logging.warning(f"[{server}:{key}] Disconnected or error: {line}")
                disconnected = True
                break

            if "time=" in line:
                try:
                    time_part = line.split("time=")[1].split()[0]
                    if time_part == last_time:
                        stable_count += 1
                    else:
                        stable_count = 0
                    last_time = time_part
                    if stable_count >= 30:
                        logging.warning(f"[{server}:{key}] Stream frozen for 30 seconds, restarting...")
                        break
                except Exception as e:
                    logging.error(f"Error parsing time in line: {line} - {e}")

            # فقط هر 60 ثانیه یک‌بار لاگ فریم یا بیت‌ریت
            now = time.time()
            if ("frame=" in line or "bitrate=" in line) and (now - last_log_time > 60):
                logging.info(f"[{server}:{key}][ffmpeg] {line}")
                last_log_time = now

        proc.terminate()
        proc.wait()

        with proc_lock:
            streaming_procs.pop(key, None)

        if not stop_event.is_set():
            if disconnected:
                logging.info(f"[{server}:{key}] Stream disconnected, restarting in 3 seconds")
            else:
                logging.info(f"[{server}:{key}] Stream ended or frozen, restarting in 3 seconds")
            time.sleep(3)
        else:
            break

    with proc_lock:
        stop_events.pop(key, None)
        streaming_threads.pop(key, None)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000)


        """
        cmd = [
            r"C:\ffmpeg\bin\ffmpeg.exe",

            "-rtmp_live", "live",
            "-i", input_url,

            "-c:v", "libx264",
            "-preset", "veryfast",
            "-tune", "zerolatency",

            "-pix_fmt", "yuv420p",
            "-profile:v", "high",

            "-r", "30",
            "-g", "60",
            "-keyint_min", "60",

            "-b:v", "4500k",
            "-maxrate", "4500k",
            "-bufsize", "9000k",

            "-c:a", "aac",
            "-b:a", "128k",
            "-ar", "44100",
            "-ac", "2",

            "-f", "flv",
            output_url
        ]
        """