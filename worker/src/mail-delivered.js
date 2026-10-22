// Shared by sendMail (index.js) and the owner bookings list (customer.js).
export function deliveredKey(address) { return `mailok:${String(address || "").trim().toLowerCase()}`; }
