if (process.env.STRIPE_SECRET_KEY) {
    console.log("Stripe Key Present: " + process.env.STRIPE_SECRET_KEY.substring(0, 7) + "...");
} else {
    console.log("Stripe Key MISSING");
}
if (process.env.DATABASE_URL) {
    console.log("DB URL Present.");
} else {
    console.log("DB URL MISSING");
}
