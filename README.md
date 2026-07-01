# AI Metadata Scraper

AI Metadata Scraper is an aggregate metadata provider for Ting Reader. During automatic library scraping, Ting Reader can ask this plugin to clean the raw book title into a search-only title before normal scraper sources run, then passes their candidate results plus local/audio metadata to this plugin. The plugin asks an OpenAI-compatible chat completions API to choose the best metadata fields.

## Configuration

- `api_base_url`: OpenAI-compatible endpoint. You can enter either a full `/v1/chat/completions` endpoint or a service root.
- `api_key`: encrypted by Ting Reader plugin config storage.
- `model`: model name sent to the API.
- `max_candidates`: total number of sorted candidates sent to AI. Ting Reader collects candidates from all normal scraper plugins first, sorts them by title relevance, then keeps the top N.
- Before automatic normal scraper searches, Ting Reader may send only the book title to AI for search-title cleanup. This title is used as the query for normal scraper plugins and does not clean chapter titles.
- `chapter_title_cleanup`: choose how scanned chapter titles are cleaned:
  - `clean`: use Ting Reader's built-in chapter title cleanup.
  - `ai`: send chapter candidates to AI and apply returned titles in file order.
  - `preserve`: keep raw chapter titles and skip built-in cleanup.
- `max_chapter_titles`: maximum number of chapter candidates sent to AI per request when `chapter_title_cleanup` is `ai`; larger books are split into multiple requests automatically.
- `chapter_title_format`: built-in chapter title format:
  - `chapter-title`: original chapter title only, for example `Opening`.
  - `book-chapter-title`: `{book_title}-{chapter_number}-{chapter_title}`, for example `Example Book-1-Opening`.
  - `chapter-number-title`: `{chapter_number}-{chapter_title}`, for example `1-Opening`.
  - `custom`: use `custom_chapter_title_template`.
- `custom_chapter_title_template`: used when `chapter_title_format` is `custom`.

Chapter templates support:

- `{book_title}`: book title.
- `{chapter_number}`: normal chapter number, for example `1`.
- `{chapter_number_padded}`: 4-digit zero-padded chapter number, for example `0001`.
- `{chapter_title}`: original chapter title.

## Usage

Install the plugin package, configure API settings in Plugin Management, then add `AI Metadata Scraper` to a library's automatic scraper sources. It is best used together with normal sources such as Ximalaya, Fanqie, Douban, or other metadata providers.
