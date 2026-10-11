# Uruchomienie płatności Stripe

Kod aplikacji obsługuje Stripe Checkout, ale nie przechowuje kluczy Stripe. Przed przyjmowaniem prawdziwych płatności dodaj w Renderze do usługi web trzy zmienne środowiskowe:

- `STRIPE_SECRET_KEY` — klucz Stripe dla wybranego trybu testowego lub produkcyjnego.
- `STRIPE_WEBHOOK_SECRET` — sekret endpointu webhooka Stripe.
- `APP_BASE_URL` — kanoniczny publiczny adres aplikacji, np. `https://pysne.com.pl`.

W panelu Stripe dodaj endpoint webhooka pod adresem:

`https://pysne.com.pl/api/payments/stripe/webhook`

Zaznacz zdarzenia `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired` oraz `charge.refunded`. Skopiuj sekret webhooka z tego endpointu do `STRIPE_WEBHOOK_SECRET`. Tryb kluczy i webhooka musi być taki sam.

Pakiety są jednorazowe i ustalane po stronie serwera: Start — 20 pinezek za 99 zł, Rozwój — 50 za 199 zł, Popularny — 100 za 299 zł, Event — 250 za 599 zł. Nowe konto Kreatora otrzymuje 10 pinezek, a pierwszy skuteczny zakup daje dodatkowe 5 pinezek. Ten bonus jest zapisywany przy koncie i może zostać przyznany tylko raz. Master Admin i Moderator mają nielimitowane pinezki i nie kupują pakietów.

Tabela zamówień i dodatkowe pola tworzą się automatycznie przy uruchomieniu serwera, bez usuwania historii zakupów. Aplikacja weryfikuje identyfikator pakietu, cenę i liczbę pinezek, a webhook dodaje saldo idempotentnie. Zdarzenia nieudanych i wygasłych płatności oraz zwroty są zapisywane. Zwrot nie odejmuje automatycznie pinezek, które mogły już zostać wykorzystane; saldo po zwrocie należy sprawdzić i rozliczyć ręcznie.
