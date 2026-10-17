# Pysne.com.pl — wersja testowa v2

Ta gałąź (`codex/v2-test`) zawiera testowy przepływ lokalnych ofert i rezerwacji. Nie jest gałęzią główną i nie została opublikowana na produkcji.

## Podgląd

- `/oferty` — publiczne wyszukiwanie ofert po lokalizacji i promieniu; działa bez konta.
- `/marketplace/manage` — panel zalogowanego Kreatora do publikowania ofert, obsługi rezerwacji, propozycji i kodów odbioru.
- `/` — dotychczasowa strona główna z zachowanym wpisywaniem tokenu przez Odbiorcę.

## Zakres v2

- oferta jest powiązana z istniejącą pinezką Kreatora;
- dostępność jest zmniejszana atomowo przy rezerwacji, a zwalniana po odrzuceniu, anulowaniu lub wygaśnięciu;
- Odbiorca może wysłać rezerwację albo zgłoszenie „Szukam skarbu”;
- Kreator może przyjąć/odrzucić rezerwację, wysłać propozycję i potwierdzić odbiór jednorazowym kodem;
- rejestrowane są odsłony, rezerwacje, propozycje i odbiory do statystyk Kreatora;
- sesja Odbiorcy jest anonimowa i oparta na haszowanym, bezpiecznym ciasteczku.

## Świadome ograniczenie testu

Rezerwacja nie pobiera jeszcze pieniędzy i nie uruchamia wypłaty. Istniejące płatności Stripe za pakiety pinezek pozostają bez zmian. Escrow, zwroty i rozliczenie po odbiorze wymagają osobnej integracji Stripe Connect lub innego operatora marketplace; nie są udawane statusem w bazie.

Migracja bazy jest addytywna i uruchamia tabele `marketplace_*` przy starcie API. Kopia przed zmianami znajduje się w:

`/Users/michalorda/Documents/Codex/2026-10-04/backups/pysnecompl-v2-before-changes-20261017.tar.gz`
