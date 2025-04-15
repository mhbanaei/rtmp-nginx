import threading
import subprocess
import time
from flask import Flask, request

app = Flask(__name__)

# تعریف Stream Key‌های معتبر برای هر سرور
VALID_KEYS = {
    "live1": ["test", "key2_live1"],
}

@app.route("/auth", methods=["POST"])
def auth():
    server = request.args.get("server", "")  # نام سرور از Query String
    stream_key = request.form.get("name", "")  # استریم کی از Form Data

    if server in VALID_KEYS and stream_key in VALID_KEYS[server]:
        print(f"✅ Access granted to {server} with key {stream_key}")
        # در اینجا می‌توانید در صورت تمایل فرآیند ffmpeg یا منطق مرتبط با استریم رو راه‌اندازی کنید.
        return "OK", 200  # مجاز به استریم
    else:
        print(f"❌ Access denied for {server} with key {stream_key}")
        return "Forbidden", 403  # رد کردن استریم

def run_ffmpeg():
    """
    اجرای دستور ffmpeg به عنوان یک زیر process.
    """
    command = [
        r"C:\ffmpeg\bin\ffmpeg.exe",
        "-i", "rtmp://127.0.0.1/live1/test",
        "-async", "1",
        "-vsync", "-1",
        "-c", "copy",
        "-f", "flv",
        "rtmp://rtmp.cdn.asset.aparat.com:443/event/Stream_Key"
    ]
    print("Starting ffmpeg...")
    process = subprocess.Popen(command)
    return process

def ffmpeg_runner():
    """
    baraye inke ffmpeg bad az ghati kami zaman bede ke ghabli ro pak kone va lot jadid ro baz kone coldown mitoni estefade koni
    """
    while True:
        proc = run_ffmpeg()
        proc.wait()
        print("ffmpeg terminated. Restarting in 5 seconds...")
        time.sleep(5)

if __name__ == "__main__":
    # background ham estefade kone 
    ffmpeg_thread = threading.Thread(target=ffmpeg_runner, daemon=True)
    ffmpeg_thread.start()
    
    # Flusk ro baz mikone 
    app.run(host="0.0.0.0", port=8000)