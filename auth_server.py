import threading
import subprocess
import time
from flask import Flask, request

app = Flask(__name__)

# تعریف Stream Key‌های معتبر برای هر سرور
VALID_KEYS = {
    "live1": ["test", "key2_live1"],
}

# وضعیت استریم: True یعنی فعال، False یعنی غیرفعال
streaming_active = True

# نگهدارنده پروسس جاری ffmpeg برای امکان کشتن آن در صورت دریافت دستور stop
current_proc = None
proc_lock = threading.Lock()  # قفل برای دسترسی همزمان به current_proc

@app.route("/auth", methods=["POST"])
def auth():
    server = request.args.get("server", "")  # نام سرور از Query String
    stream_key = request.form.get("name", "")  # استریم کی از Form Data
    if server in VALID_KEYS and stream_key in VALID_KEYS[server]:
        print(f"✅ Access granted to {server} with key {stream_key}")
        return "OK", 200  # مجاز به استریم
    else:
        print(f"❌ Access denied for {server} with key {stream_key}")
        return "Forbidden", 403  # رد کردن استریم

@app.route("/stop", methods=["POST"])
def stop_streaming():
    global streaming_active, current_proc
    print("⚠️ Received stop command.")
    streaming_active = False
    with proc_lock:
        if current_proc is not None:
            current_proc.terminate()
            print("🛑 ffmpeg process terminated.")
            current_proc = None
    return "Streaming stopped", 200

@app.route("/start", methods=["POST"])
def start_streaming():
    global streaming_active
    print("🔔 Received start command.")
    streaming_active = True
    return "Streaming started", 200

def run_ffmpeg():
    global current_proc
    command = [
        r"C:\ffmpeg\bin\ffmpeg.exe",
        "-i", "rtmp://127.0.0.1/live1/test",
        "-async", "1",
        "-vsync", "-1",
        "-c", "copy",
        "-f", "flv",
        "rtmp://rtmp.cdn.asset.aparat.com:443/event/Streamkey" #inja streamkey khodeton ro vared konid
    ]
    print("🚀 Starting ffmpeg...")
    process = subprocess.Popen(command)
    with proc_lock:
        current_proc = process
    return process

def ffmpeg_runner():
    """
    اجرای ffmpeg فقط زمانی که streaming_active فعال باشد.
    بعد از stop، پروسس کامل متوقف می‌شود تا دوباره start زده شود.
    """
    global streaming_active, current_proc
    while True:
        # منتظر start شدن
        while not streaming_active:
            time.sleep(1)

        attempt_count = 0
        while streaming_active:
            proc = run_ffmpeg()
            ret_code = proc.wait()
            with proc_lock:
                current_proc = None

            if ret_code != 0:
                attempt_count += 1
                print(f"⚠️ ffmpeg terminated with error (attempt {attempt_count}).")
            else:
                attempt_count = 0

            if attempt_count >= 3:
                print("❌ 3 failed attempts. Disabling streaming until manual reactivation.")
                streaming_active = False
                break

            if streaming_active:
                print("⏳ Restarting ffmpeg in 5 seconds...")
                time.sleep(5)

if __name__ == "__main__":
    # اجرای ffmpeg_runner در ترد پس‌زمینه
    ffmpeg_thread = threading.Thread(target=ffmpeg_runner, daemon=True)
    ffmpeg_thread.start()

    # اجرای Flask روی پورت ۸۰۰۰
    app.run(host="0.0.0.0", port=8000)
