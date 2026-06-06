# Update Notes / یادداشت بروزرسانی

## فارسی

### تغییرات انجام شده

* بازطراحی سیستم مدیریت فرآیندهای FFmpeg برای پایداری بیشتر هنگام قطع و وصل شدن استریم‌ها.
* اضافه شدن مکانیزم محدودیت تلاش مجدد (Reconnect Retry Limit).
* جلوگیری از ایجاد حلقه بی‌نهایت هنگام قطع شدن Publisher یا از دسترس خارج شدن ورودی RTMP.
* تنظیم حداکثر 20 تلاش متوالی برای اتصال مجدد به استریم ورودی.
* توقف کامل Thread پس از رسیدن به سقف تلاش‌های مجدد و آزادسازی منابع سیستم.
* جلوگیری از مصرف بی‌رویه CPU و RAM در شرایطی که استریم منبع دیگر در دسترس نیست.
* بهبود مدیریت Processهای FFmpeg و پاکسازی صحیح منابع پس از پایان استریم.
* بهینه‌سازی تنظیمات Encoding برای سازگاری بهتر با سرویس آپارات.
* استفاده از H.264 (libx264) با تنظیمات Low-Latency و کیفیت پایدار.
* تنظیم GOP و Keyframe ثابت جهت افزایش سازگاری با سرورهای RTMP مقصد.
* بهبود لاگ‌گذاری جهت تشخیص آسان‌تر خطاها و وضعیت اتصال استریم‌ها.
* اضافه شدن مدیریت بهتر وضعیت Freeze و توقف جریان ویدئو.
* حذف تلاش‌های نامحدود برای راه‌اندازی مجدد FFmpeg در صورت قطع شدن طولانی مدت استریم.

### نتیجه

در نسخه‌های قبلی، پس از قطع شدن استریم ورودی، سرویس به صورت نامحدود اقدام به راه‌اندازی مجدد FFmpeg می‌کرد که می‌توانست باعث مصرف بیش از حد منابع سرور شود.

در نسخه جدید، پس از 20 تلاش ناموفق، فرآیند متوقف شده و سیستم منتظر درخواست Publish جدید از سمت کاربر یا سرور RTMP خواهد ماند.

---

## English

### Changes

* Redesigned FFmpeg process management for improved stream stability.
* Added reconnect retry limitation mechanism.
* Prevented infinite restart loops when the RTMP source becomes unavailable.
* Configured a maximum of 20 consecutive reconnect attempts.
* Automatically stops the monitoring thread after reaching the retry limit.
* Reduced unnecessary CPU and memory consumption during long source outages.
* Improved FFmpeg process cleanup and resource management.
* Optimized encoding settings for better compatibility with Aparat RTMP ingest servers.
* Implemented H.264 (libx264) encoding with low-latency streaming configuration.
* Added fixed GOP and keyframe interval settings for improved RTMP compatibility.
* Enhanced logging for easier troubleshooting and monitoring.
* Improved stream freeze detection and recovery handling.
* Removed unlimited FFmpeg restart behavior during prolonged disconnections.

### Result

In previous versions, the service continuously restarted FFmpeg whenever the source stream was disconnected, potentially causing excessive server resource usage.

In the new version, after 20 consecutive failed reconnect attempts, the monitoring process is stopped completely and waits for a new publish request before starting again.
