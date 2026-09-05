// Set AUTH_EMAIL_FROM only after Brevo verifies this sender and its domain.
// Restrict login mail to our business domain; a typo must not expose a personal sender.
export function loginSender(value) {
  const email = String(value).trim().toLowerCase();
  if (!/^[a-z0-9._+-]+@nakiwhitewareremoval\.vip$/.test(email)) {
    throw new Error("Authentication email requires a verified Naki business-domain sender");
  }
  return { name: "Naki Whiteware Removal", email };
}
