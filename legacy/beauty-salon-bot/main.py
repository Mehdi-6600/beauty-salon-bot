import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes, MessageHandler, filters, ConversationHandler

# تنظیمات لاگ
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

SERVICE, DATE_TIME, NAME_PHONE = range(3)

# مقادیر جایگزین (توکن و آیدی عددی تلگرام)
TOKEN = "YOUR_BOT_TOKEN_HERE"
ADMIN_CHAT_ID = "YOUR_TELEGRAM_NUMERIC_ID"

SERVICES = {
    "hair": "کوپ و استایل مو - ۳۰۰,۰۰۰ تومان",
    "nail": "کاشت و ترمیم ناخن - ۴۰۰,۰۰۰ تومان",
    "color": "رنگ و لایت - ۱,۲۰۰,۰۰۰ تومان",
    "facial": "پاکسازی پوست - ۵۰۰,۰۰۰ تومان"
}

user_data_store = {}

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [
        [InlineKeyboardButton("💇‍♀️ کوپ و استایل مو", callback_data="hair")],
        [InlineKeyboardButton("💅 خدمات ناخن", callback_data="nail")],
        [InlineKeyboardButton("🎨 رنگ و لایت", callback_data="color")],
        [InlineKeyboardButton("✨ پاکسازی پوست", callback_data="facial")]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text("سلام! به ربات رزرو نوبت سالن زیبایی خوش آمدید. لطفا خدمت مورد نظر را انتخاب کنید:", reply_markup=reply_markup)
    return SERVICE

async def service_chosen(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    service_key = query.data
    user_data_store[query.from_user.id] = {"service": SERVICES[service_key]}
    await query.edit_message_text(f"شما {SERVICES[service_key]} را انتخاب کردید.\n\nلطفاً روز و ساعت درخواستی خود را بنویسید (مثال: پنجشنبه ساعت ۱۶):")
    return DATE_TIME

async def datetime_received(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.message.from_user.id
    user_data_store[user_id]["time"] = update.message.text
    await update.message.reply_text("عالیه! در نهایت لطفاً نام و شماره تماس خود را ارسال کنید تا نوبت شما ثبت شود:")
    return NAME_PHONE

async def name_phone_received(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.message.from_user
    user_id = user.id
    user_info = update.message.text
    
    service = user_data_store[user_id]["service"]
    time_slot = user_data_store[user_id]["time"]
    
    await update.message.reply_text(f"✅ نوبت شما با موفقیت ثبت شد!\n\n🔹 خدمت: {service}\n🔹 زمان: {time_slot}\n\nهمکاران ما جهت هماهنگی نهایی با شما تماس خواهند گرفت.")
    
    admin_message = (
        f"🔔 **نوبت جدید ثبت شد!**\n\n"
        f"👤 مشتری: @{user.username if user.username else 'بدون آیدی'}\n"
        f"📞 اطلاعات تماس: {user_info}\n"
        f"💇‍♀️ خدمت: {service}\n"
        f"⏰ زمان درخواستی: {time_slot}"
    )
    try:
        await context.bot.send_message(chat_id=ADMIN_CHAT_ID, text=admin_message)
    except Exception as e:
        logging.error(f"خطا در ارسال پیام به مدیر: {e}")
        
    return ConversationHandler.END

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("عملیات رزرو نوبت لغو شد.")
    return ConversationHandler.END

def main():
    app = Application.builder().token(TOKEN).build()
    
    conv_handler = ConversationHandler(
        entry_points=[CommandHandler("start", start)],
        states={
            SERVICE: [CallbackQueryHandler(service_chosen)],
            DATE_TIME: [MessageHandler(filters.TEXT & ~filters.COMMAND, datetime_received)],
            NAME_PHONE: [MessageHandler(filters.TEXT & ~filters.COMMAND, name_phone_received)],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )
    
    app.add_handler(conv_handler)
    app.run_polling()

if __name__ == "__main__":
    main()
