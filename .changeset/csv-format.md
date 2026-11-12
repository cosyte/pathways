---
"@cosyte/pathways": patch
---

A `csv` format: delimited and fixed-width text, read into a table and written back byte for byte when untouched.

- `format: csv` hands the transform a `CsvTable`, `{ header, rows }`: with a header line (the default) each row is an object of cells by column name, made with no prototype, so a column named `__proto__` or `constructor` is an ordinary cell; with `header: false`, `header` is `null` and each row is an array of cells. A file destination writes `.csv` and an HTTP destination sends `text/csv`.
- A channel's new `csv:` block sets `delimiter`, `quote`, `escape`, `header`, `encoding` (`utf-8`, strict, or `latin1`), `newline` (`crlf`, `lf` or `cr`, written after a changed or new line; lines are read on all three), `pad`, `escapeFormulas` and `maxRowLength`, or `columns: [{ name, start, length }]` for fixed-width lines, counted in characters from 1. The block is refused on a channel of another format.
- A body that cannot be read fails with `CSV_RAGGED_ROW`, `CSV_DUPLICATE_HEADER`, `CSV_UNTERMINATED_QUOTE`, `CSV_INVALID_QUOTE`, `CSV_ROW_TOO_LONG` or `CSV_SHORT_LINE`; a table that cannot be written fails its output with `CSV_UNKNOWN_COLUMN`, `CSV_VALUE_TOO_WIDE`, `CSV_INVALID_CELL` or `CSV_NOT_ENCODABLE`. The text of each names a line or a column position, never a cell.
- A line the transform leaves as it was read is written back as it came, so an untouched table, its byte order mark and a missing final line ending included, goes out byte for byte. With `escapeFormulas: true`, a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a leading `'`, quoted, in untouched lines too.
- New public types: `CsvTable`, `CsvRecord`, `CsvSettings` and `CsvColumn`. `Format`, `MessageTypes` and `MessageFor` gain `csv`, and `TransformFor<"csv">` types a csv transform. Nothing a caller must change, unless code handles every `Format` in an exhaustive switch: it now has a `csv` case to handle.
