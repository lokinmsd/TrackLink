# Трекер ссылок: Render + Supabase

## Supabase
1. SQL Editor → вставьте schema.sql → Run.
2. Project Settings → Database → Connection string → вкладка "Session pooler" → скопируйте строку
   (postgresql://postgres.xxxx:ПАРОЛЬ@...pooler.supabase.com:5432/postgres). Это DATABASE_URL.

## Render
1. Залейте папку в репозиторий GitHub → New → Web Service → выберите репозиторий.
2. Build Command: `npm install`   Start Command: `npm start`   Plan: Free
3. Environment:
   DATABASE_URL = строка из Supabase
   BOT_TOKEN = токен от @BotFather
   WEBHOOK_SECRET = случайная строка из букв и цифр
   BASE_URL = https://ВАШ-СЕРВИС.onrender.com (без слеша в конце)
4. После деплоя откройте в браузере:
   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<BASE_URL>/webhook&secret_token=<WEBHOOK_SECRET>
5. Напишите боту /start, затем /new https://example.com.
   Кнопка меню: @BotFather → Bot Settings → Menu Button → <BASE_URL>/app

## Важно про бесплатный Render
Сервис засыпает через ~15 минут без запросов, первый переход по ссылке после сна тянется до минуты.
Лечится бесплатным пингом раз в 10 минут на адрес BASE_URL/ (UptimeRobot или cron-job.org).
