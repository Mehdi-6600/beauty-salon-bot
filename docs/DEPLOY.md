# استقرار Hyper Sina (هایپر سینا)

دو مسیر وجود دارد: **Vercel** (نمایش/تست سریع، بدون سرور جدا) و **یک میزبان Node با دیسک نوشتنی** (استفادهٔ جدی). نکتهٔ اصلی همین‌جا شروع می‌شود:

> داده‌های این برنامه در یک فایل SQLite نگه داشته می‌شوند. محیط Serverless/Vercel Functions دیسک نوشتنیِ پایدار ندارد؛ فایل دیتابیس بین دو فراخوانی ممکن است از بین برود. برای دادهٔ واقعی یا از دیسک متصل‌شده استفاده کنید یا برنامه را روی یک ماشین معمولی اجرا کنید.

---

## ۱) Vercel

1. در [vercel.com/new](https://vercel.com/new) مخزن را Import کنید.
2. **Framework Preset** را روی `Other` بگذارید.
3. Build command: `node scripts/build.js` — Output directory: **خالی** (برنامه bundle نمی‌شود؛ `web/` مستقیم سرو می‌شود).
4. Environment variables (در صورت نیاز):
   * `HYPER_SINA_SESSION_SECRET` — رشته‌ای تصادفی و بلند. اگر ندهید، سرور فایلی به نام `data/secret.key` می‌سازد که در سرورلس بین warm-startها از بین می‌رود و همهٔ نشست‌ها می‌پرند.
   * `HYPER_SINA_TZ` — پیش‌فرض `Asia/Tehran`.
   * `HYPER_SINA_DB` — مسیر فایل دیتابیس؛ فقط با دیسک متصل‌شده معنا دارد.
5. Deploy. فایل `vercel.json` همهٔ مسیرها را به `api/index.js` (Function) هدایت می‌کند و `Cache-Control` را برای `/api/*` روی `no-store` می‌گذارد.

`api/index.js` همان `createHandler` سرور محلی است؛ یعنی کدِ تست‌شده روی Vercel اجرا می‌شود، نه یک نسخهٔ دوم.

### Persistence روی Vercel — گزینه‌ها

| گزینه | وضعیت |
|---|---|
| بدون کار اضافه | فقط برای دمو/پیش‌نمایش. داده ممکن است ناپدید شود؛ اپ عمداً در حالت read-only نوشتن را رد می‌کند و پیام فارسی می‌دهد |
| دیسک/Volume متصل‌شده (Vercel Sandbox/FS سازگار با `HYPER_SINA_DB`) | اگر در پلن شما موجود است، `HYPER_SINA_DB=/vercel/data/hyper-sina.db` را ست کنید |
| ماشین مجز + Vercel به‌عنوان فرانت | توصیهٔ ما: API را روی ماشین خودتان نگه دارید و دامنه را به همان ماشین وصل کنید |
| مهاجرت به Postgres/MySQL | لایهٔ داده در `server/db.js` پشت یک `createDb` با رابط `all/get/run/tx/exec/close` است؛ پیاده‌سازی جدید همان رابط، تنها نقطهٔ تغییر است |

## ۲) Node روی ماشین خودتان (توصیه‌شده)

```bash
git clone https://github.com/<owner>/hyper-sina.git && cd hyper-sina
mkdir -p data
HYPER_SINA_DB=$PWD/data/hyper-sina.db PORT=3000 node server/index.js
```

Node باید `>= 22.5` باشد (`node:sqlite`). اولین اجرا مایگریشن‌ها را اعمال می‌کند و هش آن‌ها را در جدول `schema_migrations` ثبت می‌کند.

### systemd

```ini
[Unit]
Description=Hyper Sina
After=network.target

[Service]
User=hyper
WorkingDirectory=/srv/hyper-sina
Environment=PORT=3000
Environment=HYPER_SINA_DB=/srv/hyper-sina/data/hyper-sina.db
Environment=HYPER_SINA_TZ=Asia/Tehran
ExecStart=/usr/bin/node server/index.js
Restart=always
ProtectSystem=full
ReadWritePaths=/srv/hyper-sina/data
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

### Docker

```dockerfile
FROM node:22-bookworm-slim
WORKDIR /app
COPY . .
RUN node scripts/build.js
ENV PORT=3000 HYPER_SINA_DB=/data/hyper-sina.db
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
```

```bash
docker run -d --name hyper-sina -p 3000:3000 -v hyper-sina-data:/data hyper-sina
```

### reverse proxy

* `X-Forwarded-Proto: https` را فوروارد کنید؛ کوکی نشست فقط در آن حالت `Secure` می‌شود.
* `client_max_body_size` پیش‌فرض برای JSON‌های این برنامه کافی است (هر درخواست < ۶۴KB محدود شده).
* SSL را در همان لایه تمام کنید؛ برنامه خودش HTTP سرو می‌کند.

## ۳) پشتیبان‌گیری و بازگردانی

* از داخل برنامه: `#/settings` → «پشتیبان کامل (JSON)» — همهٔ جداول به‌جز هش رمزها.
* روی دیسک: `sqlite3` لازم نیست؛ کافی است فایل را کپی کنید (WAL هم در همان لحظه کپی شود یا از حالت read-only استفاده کنید):

```bash
# نسخهٔ ساده و ایمن: بکاپ منطقی از API
curl -s -H "Cookie: hs_session=$TOKEN" https://shop.example/api/export.json > backup-$(date +%F).json
```

بازگردانی دو راه دارد:

1. **بازگرداندن فایل** (ساده‌ترین و کامل‌ترین): سرویس را متوقف کنید، `data/hyper-sina.db` را با نسخهٔ سالم عوض کنید و دوباره بالا بیاورید. چون schema فقط additive است، فایلِ نسخهٔ قدیمی روی کد جدید هم کار می‌کند.
2. **بازپاشی JSON**: فایل بکاپ شامل همهٔ ردیف‌هاست اما ابزار خودکارِ import ندارد؛ داده‌ها را با همان `POST /api/*` دوباره ثبت کنید (برای هر ثبت یک `dedupe_key` تازه بسازید تا با ردیف‌های قدیمی برخورد نکند). این مسیر عمدی است: هیچ واردات خامی اجازه ندارد از اعتبارسنجی‌های سرور رد شود.

* برنامه هیچ‌وقت بدون تایپ عبارت «پاک کن» داده‌ای را حذف نمی‌کند و پیش از آن یک `pre-reset-*.json` کنار فایل دیتابیس می‌نویسد.

## ۴) ارتقای نسخه

1. `git pull` — ماگریشن‌های جدید در اولین اجرا اعمال می‌شوند (هر کدام داخل یک تراکنش).
2. ویرایش یک مایگریشنِ اجراشده عمداً با خطا متوقف می‌شود؛ به‌جایش مایگریشن جدید اضافه کنید.
3. پیش از ارتقا، از فایل دیتابیس کپی بگیرید. برای برگشت، همان کپی را برگردانید و نسخهٔ قبلی کد را اجرا کنید (schema فقط additive است).

## ۵) بررسی پس از استقرار

```bash
curl -s $URL/api/health                       # {"ok":true,...,"db":"sqlite"}
curl -s $URL/api/bootstrap | head -c 400      # needs_setup:true تا وقتی حساب نساخته‌اید
# بسازید و وارد شوید، سپس:
curl -s -b cj -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
     -d '{"date":"2026-10-10","category":"rent","payment_method":"cash","amount_toman":500000,"paid_toman":500000}' \
     $URL/api/expenses
curl -s -b cj $URL/api/dashboard | head -c 400
```

انتظار: `201` برای ثبت، سپس عدد هزینه در `month_report.expenses.total_rial` (به ریال). اگر `403` گرفتید، توکن CSRF یا کوکی درست فرستاده نشده؛ اگر `429` گرفتید، محدودهٔ تلاش ناموفق ورود فعال شده است.

## ۶) آنچه در این محیط تست/تأیید نشده

* **استقرار واقعی روی Vercel از این سندرومbox انجام نشد**: شبکه به `vercel.com`/`api.vercel.com` مسدود بود و هیچ توکن یا اتصال Vercel برای این گفت‌وگو در دسترس نبود. بنابراین `vercel.json` و `api/index.js` نوشته و به‌صورت محلی با همان `createHandler` اجرا/تست شده‌اند، اما «دیپلوی موفق روی Vercel» تأیید نشده است.
* persistence روی دیسک خواندنی سرورلس هم عملاً قابل تست نبود؛ مسیر fallback در کد وجود دارد و در حالت read-only نوشتن رد می‌شود.
* همهٔ ۵۳ آزمون (`npm test`) روی Node v22.22.3 با SQLiteٔ محلی سبز هستند؛ `npm run lint` بدون خطا.
