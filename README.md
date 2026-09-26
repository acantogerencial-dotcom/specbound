# Specbound

Every ad spec. Checked before it ships.

A free, open library of ad specifications for every major platform (social, CTV, display, DOOH, retail media), with the official source linked on every page.

## How it works

- Every spec is one JSON file in `data/specs/<platform>/`.
- `schema/spec.schema.json` defines exactly what a spec file may contain. Unknown values are `null`, never guessed.
- `npm run validate` checks every file against the schema. The build fails if anything is wrong, so bad data can't reach the site.
- Adding a JSON file adds a page. Nothing else to touch.
- Only a human approval sets `"status": "verified"`.

## Run locally (optional)

```
npm install
npm run dev
```

## Contribute a correction

Open an issue with the page link and the official source showing the correct value.

## License

Spec data: CC BY 4.0 (see DATA-LICENSE.md). Code: MIT.
