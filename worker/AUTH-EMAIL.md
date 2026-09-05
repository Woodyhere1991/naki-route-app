# Login email sender

Customer sign-in, sign-up and private profile-invite codes use a dedicated Brevo
sender when AUTH_EMAIL_FROM is configured. Owner sign-in and ordinary business
mail retain their current routing. No new provider or subscription is required.

Activation requires:

1. In the existing Brevo account, add and authenticate nakiwhitewareremoval.vip.
   Add only the DNS records Brevo provides; preserve existing mail records.
2. Confirm no-reply@nakiwhitewareremoval.vip is an active sender.
3. Confirm the production Worker has a working BREVO_API_KEY.
4. Set AUTH_EMAIL_FROM to no-reply@nakiwhitewareremoval.vip in Worker vars and
   deploy the verified Worker release. Keep the setting in wrangler.jsonc so
   subsequent releases preserve it.
5. Request a code for an owner-controlled test mailbox. Verify actual receipt,
   From address and DKIM/DMARC results, then complete customer sign-in.

When enabled, a failed Brevo request fails the code send; it never retries via
personal Gmail. Missing AUTH_EMAIL_FROM retains existing behavior for rollout
compatibility. The code alone does not activate or verify a sender.
