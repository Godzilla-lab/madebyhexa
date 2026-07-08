# Supabase auth email templates (branded, code-based)

The sign-up and password-reset flows on login.html expect a **numeric code**
in the email, not a link. These templates put the code front and center in
the Hexa house style. Until they are pasted in, Supabase keeps sending its
generic link emails and the code screens cannot complete.

## Paste them in (one-time, ~3 minutes)

Supabase Dashboard -> Authentication -> Emails (templates tab):

| Template in dashboard  | File                  | Subject line to set                  |
| ---------------------- | --------------------- | ------------------------------------ |
| Confirm signup         | `confirm-signup.html` | `Your Hexa code: {{ .Token }}`       |
| Reset password         | `reset-password.html` | `Your Hexa reset code: {{ .Token }}` |
| Change email address   | `change-email.html`   | `Confirm your new Hexa email`        |

For each: open the file, copy everything, replace the template body in the
dashboard, set the subject, save.

## Set the code lifetime to 15 minutes

Authentication -> Providers -> Email -> "Email OTP expiration": set to `900`
(seconds). The login screen and the emails both tell people 15 minutes, so
keep these in sync if you ever change it.

Magic link and invite templates are unused (the magic-link option was removed
from the sign-in page) and can stay as they are.
