# Uruchomienie płatności Stripe

Kod aplikacji obsługuje Stripe Checkout, ale nie przechowuje kluczy Stripe. Przed przyjmowaniem prawdziwych płatności dodaj w Renderze do usługi web trzy zmienne środowiskowe:

- `STRIPE_SECRET_KEY` — klucz Stripe dla wybranego trybu testowego lub produkcyjnego.
- `STRIPE_WEBHOOK_SECRET` — sekret endpointu webhooka Stripe.
- `APP_BASE_URL` — kanoniczny publiczny adres aplikacji, np. `https://pysne.com.pl`.

W panelu Stripe dodaj endpoint webhooka pod adresem:

`https://pysne.com.pl/api/payments/stripe/webhook`

Zaznacz zdarzenia `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` oraz `checkout.session.expired`. Skopiuj sekret webhooka z tego endpointu do `STRIPE_WEBHOOK_SECRET`. Tryb kluczy i webhooka musi być taki sam.

Pakiety są ustalane po stronie serwera: 50 pinezek za 249 zł, 100 za 449 zł, 250 za 849 zł. Po zweryfikowaniu potwierdzenia Stripe aplikacja dodaje zakupione pinezki do zalogowanego konta Kreatora. Master Admin i Moderator nie kupują pakietów.

Tabela zamówień tworzy się automatycznie przy uruchomieniu serwera. Zwroty płatności należy na tym etapie rozliczać ręcznie, ponieważ aplikacja nie odbiera jeszcze automatycznie pinezek po zwrocie.
