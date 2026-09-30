# Netherlands Weather for Omarchy

A bar widget for the [Omarchy](https://omarchy.org) shell that replaces
the built-in weather widget.

This is a fork of [nameproof/nordic-weather](https://github.com/nameproof/nordic-weather),
adapted for the Netherlands: the forecast still comes from MET Norway (its
model covers the whole world, not just the Nordics), but the radar map and
rain nowcast now come from [Buienradar](https://www.buienradar.nl), the
Dutch national precipitation radar, instead of yr.no's Nordic-only radar.

Includes a weather radar that is lazy-loaded, so the forecast itself stays
light. Because Buienradar hands out whole, already-rendered radar images
(rather than raw map tiles the original had to composite onto its own
OpenStreetMap base), this fork's radar pipeline is considerably simpler
than upstream's: no base-map tiles, no shader recolouring, no ImageMagick
compositing step — each frame is just downloaded and shown as-is.

The radar map covers the Netherlands and the fringes of Belgium, Germany
and the UK; the rain-nowcast sentence in the panel only works inside that
same box. Outside it, only the forecast shows. Locations work the same way
the built-in Omarchy weather widget does, just with added favourites.

Languages: Dutch or English, following the system locale; English for
anything else.

## What changed from upstream

- **Radar**: Buienradar's national composite (undocumented but widely used
  by the Dutch developer community; free for non-commercial use, with
  required attribution — see Credits) replaces yr.no's tiles. No pan/zoom:
  Buienradar always renders the whole country at a fixed size, so the `+`
  / `−` zoom controls are gone.
- **Rain nowcast** (the "next N minutes" sentence and sparkline): Buienradar's
  `raintext` feed replaces MET's nowcast API. It only carries a precipitation
  rate, not temperature/wind/humidity, so the current-conditions numbers now
  always come from the hourly forecast model rather than a live observation.
- **Lightning**: dropped. Buienradar has no public lightning feed, and MET's
  nowcast-analysis lightning glyph and the old yr.no-based bolts covered a
  different fallback path. It may come back via a separate lightning
  network if there's a clean free source; PRs welcome.
- **Languages**: trimmed to Dutch and English (from Swedish, Norwegian,
  Danish and Finnish), since this fork is scoped to one country.
- **Forecast**: unchanged — MET Norway's model covers the Netherlands fine.

## Install

```sh
omarchy plugin add https://github.com/toldenburger/nordic-weather.git --enable
```

Remove it with `omarchy plugin remove io.github.toldenburger.netherlands-weather`.
Optionally remove the cache that holds a few MB of radar frames:
`rm -rf ~/.cache/io.github.toldenburger.netherlands-weather`

Needs `curl`, included in Omarchy. (Unlike upstream, ImageMagick is no
longer required: there's nothing left to composite.)

Enabling the plugin puts it in the built-in weather widget's place in the bar.
Disabling or removing it brings the built-in back.

## Use

Just click around, some advanced motions do exist however:

| Action | Result |
|---|---|
| Left click | Open or close the panel |
| Right click | Notification with current weather |
| Middle click, or `r` in the panel | Refresh now |
| Click the place name, or Enter in the panel | Search for a location, or pick a favourite |
| Click the ☆ / ★ on a search result | Add or remove that place as a favourite |
| Click **Radar ›**, or → / `l` in the panel (← / `h` closes) | Show the radar map beside the forecast |
| Click the map, or `p` | Pause or play the radar loop |
| `,` / `.` | Step the radar loop back or forward a frame |
| ↑ / ↓ (`k` / `j`), Tab | Scroll the panel, switch to the neighbouring panel |
| `omarchy-shell omarchy.weather toggle` / `edit` / `refresh` / `radar` | The same, from a keybind |
| `omarchy-shell omarchy.weather favorite next` / `favorite previous` | Switch to the next or previous favourite |

Settings live on the widget's entry in `~/.config/omarchy/shell.json`

## Development

`Service.qml` is the one data source (fetching, cache, radar, IPC) behind
every monitor's `BarWidget.qml` (the pill) and `Panel.qml` (the popout, only
loaded while open). `Model.js` holds the pure logic as plain JavaScript.

```sh
npm test                    # model and Qt/Quickshell service tests
scripts/dev-sync            # copy into ~/.config/omarchy/plugins/ (hot-reloads)
scripts/dev-sync --enable
scripts/lint                # qmllint against the installed Omarchy shell
```

## Credits

- Weather: [MET Norway](https://api.met.no), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Radar and rain nowcast: [Buienradar.nl](https://www.buienradar.nl) — free
  for non-commercial use, attribution required by their terms; this fork is
  a personal, non-commercial Omarchy plugin and credits Buienradar in the
  panel and here. Their endpoints used here (image/metadata and `raintext`)
  are undocumented but stable and widely relied upon by the Dutch developer
  community.
- Place search: [Open-Meteo](https://open-meteo.com/en/docs/geocoding-api)
- Forked from [nameproof/nordic-weather](https://github.com/nameproof/nordic-weather),
  whose original Nordic build additionally credited yr.no (radar and
  lightning) and © OpenStreetMap contributors (its own base map); neither
  is used here.
