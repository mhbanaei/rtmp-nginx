import subprocess
import time

def run_ffmpeg():
    # Command-e ffmpeg be soorate liste ba taghsim-e argumanta
    command = [
        r"C:\ffmpeg\bin\ffmpeg.exe",
        "-i", "rtmp://127.0.0.1/live1/test",
        "-async", "1",
        "-vsync", "-1",
        "-c", "copy",
        "-f", "flv",
        "rtmp://rtmp.cdn.asset.aparat.com:443/event/Your_StreamKey" #StreamKey khod ro dar hamin bakhshi ke gharar dadam , gharar bedid;
    ]
    print("Starting ffmpeg...")
    # Ejra-e ffmpeg va bazyab kardan process
    process = subprocess.Popen(command)
    return process

def main():
    while True:
        proc = run_ffmpeg()
        # Intizar baraye tamam shodan-e process (masalan vaghti etesal gheto shavad)
        proc.wait()
        print("ffmpeg terminated. Restarting in 5 seconds...")
        time.sleep(5)

if __name__ == '__main__':
    main()