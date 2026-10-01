pragma ComponentBehavior: Bound
import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Networking
import qs.Commons
import "Model.js" as Model

// The one data source behind the weather pill and panel. Omarchy mounts a
// service once, however many monitors (and so bar widgets and panels) there
// are, following Quickshell's guidance to keep processes and timers out of
// per-screen components: widgets and panels only present what is here.
// Model.js holds the pure logic.
//
// Panels report what they show (open, radar open, map size) with
// updateViewer(); the radar only downloads while some panel shows it.
Scope {
  id: root

  // Injected by the Omarchy shell: a scoped API (summon/hide/toggle for this
  // plugin) and our manifest.
  property var shell: null
  property var manifest: null
  readonly property string userAgent: Model.userAgent(manifest)

  readonly property string pluginId: Model.PLUGIN_ID

  Component.onCompleted: console.log("netherlands-weather: service started")

  // ---------------------------------------------------------------- settings

  readonly property string lang: Model.langFor(Qt.locale().name)
  readonly property var t: Model.strings(lang)

  // From the bar entry in shell.json (BarWidget passes them on).
  property int hourStep: 3
  property int hourlyDays: 3
  property int longRangeDays: 10
  onHourStepChanged: rebuild()
  onHourlyDaysChanged: rebuild()
  onLongRangeDaysChanged: rebuild()

  function setDisplaySettings(settings) {
    var s = settings || {}
    var step = parseInt(s.hourStep, 10)
    var days = parseInt(s.hourlyDays, 10)
    var range = parseInt(s.longRangeDays, 10)
    hourStep = isNaN(step) ? 3 : Math.max(1, Math.min(6, step))
    hourlyDays = isNaN(days) ? 3 : Math.max(1, Math.min(3, days))
    longRangeDays = isNaN(range) ? 10 : Math.max(0, Math.min(10, range))
  }

  readonly property string cacheDir: (Quickshell.env("XDG_CACHE_HOME") || (Quickshell.env("HOME") + "/.cache"))
    + "/" + Model.PLUGIN_ID
  readonly property string tilesDir: cacheDir + "/tiles"

  // ---------------------------------------------------------------- viewers

  // What the panels show, by panel: { open, radarOpen, width, height }.
  property var viewers: ({})
  readonly property bool anyOpen: {
    for (var k in viewers) if (viewers[k].open) return true
    return false
  }
  // The panel showing the radar (at most one popout is open at a time).
  readonly property var radarViewer: {
    for (var k in viewers) if (viewers[k].open && viewers[k].radarOpen) return viewers[k]
    return null
  }

  function updateViewer(id, state) {
    var next = Object.assign({}, viewers)
    next[id] = state
    viewers = next
  }

  function removeViewer(id) {
    if (!(id in viewers)) return
    var next = Object.assign({}, viewers)
    delete next[id]
    viewers = next
  }

  onAnyOpenChanged: if (anyOpen) {
    locationFile.reload()
    rebuild()
    Qt.callLater(maybeFetch, false)
  }

  // ---------------------------------------------------------------- state

  // Shared with the built-in widget and omarchy-weather-location.
  property var location: ({ name: "", latitude: null, longitude: null })
  readonly property bool hasLocation: Model.hasCoordinates(location)

  // { forecast, nowcast, sun, moon, radar: cache entries (see Model.isFresh),
  //   elevations: { "lat,lon": metres }, prefs: {} }
  property var cache: ({})
  property bool cacheLoaded: false

  property var view: Model.buildView({ lang: root.lang, nowMs: Date.now(), location: root.location })
  property bool stale: false
  property string lastError: ""

  // Spread refreshes out after each Expires (MET asks for no synchronised
  // traffic). Fixed per session so it doesn't drift per tick.
  readonly property int refreshJitterMs: Model.jitterMs()
  // After a 429, requests to that service ("met" or "br", Model.requestService)
  // pause until this time.
  property var backoffUntil: ({ met: 0, br: 0 })
  property var failures: ({})

  // Parsed bodies, reused until the cached body changes.
  property var parsedMemo: ({})

  // Network state from NetworkManager (Quickshell.Networking; Omarchy's own
  // network widget uses it too). Offline, requests are skipped rather than
  // failed, so the back-off doesn't grow; when the connection comes back,
  // everything due is fetched at once instead of after the back-off.
  // Without NetworkManager this stays Unknown and nothing changes.
  readonly property int connectivity: Networking.connectivity
  readonly property bool offline: connectivity === NetworkConnectivity.None
    || connectivity === NetworkConnectivity.Limited || connectivity === NetworkConnectivity.Portal
  onConnectivityChanged: {
    console.log("netherlands-weather: connectivity " + connectivity)
    if (connectivity === NetworkConnectivity.Full) {
      failures = ({})
      // Later: `offline` (derived from connectivity) may not have caught up
      // yet in this handler, and would skip the fetch (e.g. after a wake).
      Qt.callLater(maybeFetch, false)
    }
  }

  onLocationChanged: {
    rebuild()
    maybeFetch(false)
  }

  function locationForRequests() {
    var key = Model.roundCoord(location.latitude) + "," + Model.roundCoord(location.longitude)
    var elevations = cache.elevations || {}
    return {
      name: location.name,
      latitude: location.latitude,
      longitude: location.longitude,
      elevation: typeof elevations[key] === "number" ? elevations[key] : null
    }
  }

  // Both read `location` itself rather than hasLocation: they run from
  // onLocationChanged, where that derived value may not have caught up.
  function requestUrls() {
    if (!Model.hasCoordinates(location)) return null
    var loc = locationForRequests()
    var now = Date.now()
    return {
      forecast: Model.forecastUrl(loc),
      nowcast: Model.nowcastUrl(loc),
      sun: Model.sunUrl(loc, now),
      moon: Model.moonUrl(loc, now)
    }
  }

  function parsedFor(kind, url) {
    var entry = cache[kind]
    if (!entry || entry.key !== url || !entry.body) return null
    var memo = parsedMemo[kind]
    if (memo && memo.key === url && memo.body === entry.body) return memo.value
    var value = kind === "sun" ? Model.parseSun(entry.body)
      : kind === "moon" ? Model.parseMoon(entry.body, entry.fetchedMs)
      : kind === "nowcast" ? Model.parseRaintext(entry.body, entry.fetchedMs)
      : Model.parseTimeseries(entry.body)
    var next = Object.assign({}, parsedMemo)
    next[kind] = { key: url, body: entry.body, value: value }
    parsedMemo = next
    return value
  }

  function rebuild() {
    var urls = requestUrls()
    var now = Date.now()
    var forecast = urls ? parsedFor("forecast", urls.forecast) : null
    // While a new place's forecast loads, keep showing the previous view
    // (the search field stays open with a spinner) rather than flashing empty.
    if (urls && !forecast && forecastProc.running && view.ready) return

    view = Model.buildView({
      forecast: forecast,
      nowcast: urls ? parsedFor("nowcast", urls.nowcast) : null,
      sun: urls ? parsedFor("sun", urls.sun) : null,
      moon: urls ? parsedFor("moon", urls.moon) : null,
      location: location,
      lang: lang,
      nowMs: now,
      settings: { hourStep: hourStep, hourlyDays: hourlyDays, longRangeDays: longRangeDays }
    })
    var entry = cache.forecast
    stale = !!entry && !!urls && entry.key === urls.forecast && now > entry.expiresMs + 60 * 60000
  }

  // ---------------------------------------------------------------- fetching

  function entryFor(kind) {
    return cache[kind]
  }

  function isDue(kind, url, now) {
    var entry = entryFor(kind)
    var failure = failures[kind]
    if (failure && failure.key === url && now < failure.nextMs) return false
    if (!entry || entry.key !== url) return true
    // Sun and moon are keyed by date; one fetch per day is plenty.
    if (kind === "sun" || kind === "moon") return false
    // Nowcast keeps the bar's "now" fresh: every 15 min in the background,
    // as often as Expires allows (~5 min) while a panel is open. The
    // minimum gaps also guard against an Expires that is already in the
    // past on arrival, which would otherwise mean a request on every tick.
    if (kind === "nowcast")
      return now >= Math.max(entry.expiresMs, entry.fetchedMs + (anyOpen ? 2 * 60000 : Model.NOWCAST_BACKGROUND_MS))
    // The radar index: only polled while the radar is on screen.
    if (kind === "radar")
      return now >= Math.max(entry.expiresMs, entry.fetchedMs + 2 * 60000)
    return now >= Math.max(entry.expiresMs + refreshJitterMs, entry.fetchedMs + 5 * 60000)
  }

  // force: middle click / IPC refresh. Skips the Expires wait, but still
  // sends If-Modified-Since, so an unchanged forecast costs a 304.
  function maybeFetch(force) {
    if (!Model.hasCoordinates(location) || !cacheLoaded || offline) return
    var now = Date.now()
    var urls = requestUrls()
    if (now >= backoffUntil.met) {
      startFetch(forecastProc, "forecast", urls.forecast, force || isDue("forecast", urls.forecast, now))
      startFetch(sunProc, "sun", urls.sun, isDue("sun", urls.sun, now))
      startFetch(moonProc, "moon", urls.moon, isDue("moon", urls.moon, now))
    }
    if (now >= backoffUntil.br) {
      // Buienradar's rain feed only covers the Netherlands and its fringes;
      // outside that box, remember it for a day instead of asking every time.
      if (Model.hasRainCoverage(location)) {
        startFetch(nowcastProc, "nowcast", urls.nowcast, force || isDue("nowcast", urls.nowcast, now))
      } else if (!cache.nowcast || cache.nowcast.key !== "out-of-coverage") {
        setCacheEntry("nowcast", { key: "out-of-coverage", body: "", lastModified: "", expiresMs: now + 24 * 3600000, fetchedMs: now })
      }
      if (radarActive) {
        startFetch(radarProc, "radar", Model.radarIndexUrl(), force || isDue("radar", Model.radarIndexUrl(), now))
        maybeDownloadRadarFrames()
      }
    }
  }

  function startFetch(proc, kind, url, due) {
    if (!due || proc.running) return
    var entry = entryFor(kind)
    var lastModified = entry && entry.key === url ? entry.lastModified : ""
    proc.url = url
    proc.command = Model.curlCommand(url, lastModified, kind === "forecast" ? 15 : 10, userAgent)
    proc.running = true
  }

  function refresh(force) {
    failures = ({})
    maybeFetch(force === true)
  }

  function recordFailure(kind, url, message) {
    var next = Object.assign({}, failures)
    var previous = next[kind] && next[kind].key === url ? next[kind].count : 0
    var count = previous + 1
    // 15 s, 30 s, 60 s … capped at 15 min; the tick picks it up again.
    next[kind] = { key: url, count: count, nextMs: Date.now() + Math.min(15 * 60000, 15000 * Math.pow(2, count - 1)) }
    failures = next
    if (kind === "forecast") lastError = message
  }

  function handleResponse(kind, url, raw) {
    var now = Date.now()
    var response = Model.parseHttpResponse(raw)
    var urls = requestUrls()
    var current = urls && urls[kind] === url

    console.log("netherlands-weather: " + kind + " HTTP " + (response.status || "failed")
      + (response.headers.expires ? ", expires " + response.headers.expires : ""))
    if (response.status === 203)
      console.warn("netherlands-weather: " + kind + " API version is deprecated: " + url)
    if (response.status === 200 || response.status === 203 || response.status === 304) {
      var unreadable = response.status !== 304 && (
        (kind === "forecast" && !Model.parseTimeseries(response.body))
        || (kind === "nowcast" && Model.parseRaintext(response.body, now).steps.length < 2)
        || (kind === "radar" && !Model.parseRadarIndex(response.body).length))
      if (unreadable) {
        recordFailure(kind, url, "unreadable response")
      } else {
        var fallbackTtl = kind === "radar" ? 60000
          : kind === "nowcast" ? 5 * 60000 : kind === "forecast" ? 30 * 60000 : 24 * 3600000
        var entry = Model.cacheEntryFromResponse(entryFor(kind), url, response, now, fallbackTtl)
        setCacheEntry(kind, entry)
        var cleared = Object.assign({}, failures)
        delete cleared[kind]
        failures = cleared
        if (kind === "forecast") lastError = ""
      }
    } else if (response.status === 429) {
      var service = Model.requestService(kind)
      console.warn("netherlands-weather: throttled by " + service + " (429), pausing its requests for 10 min")
      var next = Object.assign({}, backoffUntil)
      next[service] = now + 10 * 60000
      backoffUntil = next
      recordFailure(kind, url, "HTTP 429")
    } else {
      if (response.status === 403) console.warn("netherlands-weather: 403 Forbidden for " + url)
      recordFailure(kind, url, response.status ? "HTTP " + response.status : "network error")
    }

    if (kind === "forecast" && current) finishSavingLocation()
    // An awaited radar index is answered only once it is stored: ended
    // earlier, the radar would briefly count as usable with the old index
    // and start loading from it.
    if (kind === "radar" && radarAwaiting) {
      radarAwaiting = false
      radarClockMs = now
    }
    rebuild()
  }

  function setCacheEntry(kind, entry) {
    var next = Object.assign({}, cache)
    next[kind] = entry
    cache = next
    writeCache()
  }

  function setPref(name, value) {
    var next = Object.assign({}, cache)
    var prefs = Object.assign({}, cache.prefs || {})
    prefs[name] = value
    next.prefs = prefs
    cache = next
    writeCache()
  }

  function writeCache() {
    if (!cacheLoaded) return
    cacheFile.setText(JSON.stringify(cache) + "\n")
  }

  // ---------------------------------------------------------------- location search

  property var locationSuggestions: []
  property bool geocodeSearched: false
  property bool savingLocation: false
  property string geocodePendingQuery: ""
  property string geocodeActiveQuery: ""

  // A picked place's forecast has arrived (or failed): panels close the search.
  signal locationSaved()

  // One request at a time; if the query moved on while a request was in
  // flight, the latest query is fetched right after. (Panels debounce typing.)
  function search(text) {
    var query = String(text || "").trim()
    if (query.length < 2) {
      clearSearch()
      return
    }
    geocodePendingQuery = query
    if (!geocodeProc.running) startGeocode()
  }

  function clearSearch() {
    geocodePendingQuery = ""
    locationSuggestions = []
    geocodeSearched = false
    savingLocation = false
  }

  function searchBusy() {
    return geocodeProc.running
  }

  function startGeocode() {
    geocodeActiveQuery = geocodePendingQuery
    geocodeProc.command = Model.geocodeCommand(geocodeActiveQuery, root.lang, root.userAgent)
    geocodeProc.running = true
  }

  function pickSuggestion(suggestion) {
    if (!suggestion) return
    savingLocation = true
    if (typeof suggestion.elevation === "number") {
      var next = Object.assign({}, cache)
      var elevations = Object.assign({}, next.elevations || {})
      elevations[Model.roundCoord(suggestion.latitude) + "," + Model.roundCoord(suggestion.longitude)] = suggestion.elevation
      next.elevations = elevations
      cache = next
      writeCache()
    }
    location = { name: suggestion.name, latitude: suggestion.latitude, longitude: suggestion.longitude }
    persistLocation(["--set", suggestion.name, suggestion.latitude + "," + suggestion.longitude])
    // Already-cached place: nothing to wait for.
    if (!forecastProc.running) finishSavingLocation()
  }

  function finishSavingLocation() {
    if (!savingLocation) return
    clearSearch()
    locationSaved()
  }

  // ---------------------------------------------------------------- favourites

  // Model.parseFavorites; this plugin's own file, next to the shared
  // weather.json.
  readonly property string favoritesPath: Quickshell.env("HOME") + "/.local/state/omarchy/settings/netherlands-weather-favorites.json"
  property var favorites: []

  function setFavorites(list) {
    favorites = list
    favoritesFile.setText(JSON.stringify(list, null, 2) + "\n")
  }

  // Star or unstar a search result (it keeps its description and elevation).
  function toggleFavorite(place) {
    setFavorites(Model.toggleFavorite(favorites, place))
  }

  function removeFavorite(key) {
    setFavorites(Model.removeFavorite(favorites, key))
  }

  // Next or previous favourite (IPC, for a keybind).
  function stepFavorite(step) {
    var next = Model.stepFavorite(favorites, location, step)
    if (next) pickSuggestion(next)
  }

  function persistLocation(args) {
    locationSaveProc.command = ["omarchy-weather-location"].concat(args)
    locationSaveProc.running = true
  }

  // ---------------------------------------------------------------- notification

  function notify() {
    rebuild()
    var note = Model.notification(view)
    if (!note) {
      Util.execArgv(["omarchy-notification-send", hasLocation ? t.fetching : t.noLocation])
      return
    }
    var argv = ["omarchy-notification-send", "-g", note.glyph, note.headline]
    if (note.body) argv.push(note.body)
    Util.execArgv(argv)
  }

  // ---------------------------------------------------------------- radar (Buienradar)

  // The radar map's zoom, centred on the chosen place: 1 shows Buienradar's
  // whole render (as before); higher levels crop and pan toward it
  // client-side. Remembered like the old tile map's mapStep was.
  readonly property real radarZoom: Model.clampRadarZoom(cache.prefs ? cache.prefs.radarZoom : undefined)

  function zoomRadar(delta) {
    var z = Model.clampRadarZoom(radarZoom + delta)
    if (z !== radarZoom) setPref("radarZoom", z)
  }

  function setRadarZoom(zoom) {
    zoomRadar(Model.clampRadarZoom(zoom) - radarZoom)
  }

  // The radar side panel: Buienradar's national radar composite, one
  // ready-rendered frame at a time. Only downloaded and animated while some
  // panel shows it.
  readonly property bool radarActive: radarViewer !== null && hasLocation
  onRadarActiveChanged: if (radarActive) {
    radarPlayhead = { frame: 0, tick: radarPlayhead.tick }
    radarPaused = false
    var now = Date.now()
    radarClockMs = now
    // An index refresh due now is waited for before anything shows, so a
    // loop from before (minutes or a night ago) never plays first. Decided
    // before any request starts, so nothing loads from the old index.
    var canFetch = !offline && cacheLoaded && now >= backoffUntil.br
    radarAwaiting = canFetch && isDue("radar", Model.radarIndexUrl(), now)
    if (radarAwaiting) radarAwaitTimeout.restart()
    if (!radarFresh) dropRadarLoop()
    // Later: derived values may not have caught up.
    Qt.callLater(maybeFetch, false)
  }

  // A radar index refresh awaited since the radar opened (see above). A
  // response ends the wait; so does the timeout, so a hung request can't
  // keep the radar empty.
  property bool radarAwaiting: false
  Timer {
    id: radarAwaitTimeout
    interval: 8000
    onTriggered: root.radarAwaiting = false
  }
  // Wall-clock time for the radar's age check (Model.radarUsable), set on
  // opening, when an awaited index arrives and every minute.
  property double radarClockMs: Date.now()
  readonly property var radarIndex: Model.radarFrames(cache.radar ? cache.radar.body : "")
  readonly property bool radarFresh: Model.radarUsable(radarIndex, radarClockMs, radarAwaiting,
                                                         cache.radar ? cache.radar.fetchedMs : NaN)
  onRadarFreshChanged: if (!radarFresh) dropRadarLoop()
  // What may actually be shown: nothing while too old or while a refresh is
  // still awaited.
  readonly property var radarData: radarFresh ? radarIndex : ({ frames: [], nowIndex: -1 })

  // Also forgets what was downloaded, so the frames are fetched again
  // (instant where they're still on disk) once the radar is usable.
  function dropRadarLoop() {
    shownLoop = null
    radarDoneKey = ""
  }

  // A frame image went missing on disk (e.g. cleaned up): drop the shown
  // loop and fetch again, rather than hold on a frame that can't load.
  function radarImagesFailed() {
    console.warn("netherlands-weather: radar frame images missing, reloading them")
    dropRadarLoop()
    maybeDownloadRadarFrames()
  }

  readonly property double radarNowMs: displayLoop.frames.length && displayLoop.nowIndex >= 0
    ? displayLoop.frames[displayLoop.nowIndex].timeMs : 0

  // Identifies the exact set of frame images the radar should show.
  readonly property string radarKey: radarData.frames.length ? Model.radarFramesKey(radarData.frames) : ""
  onRadarKeyChanged: {
    radarRetry.stop()
    radarRetryCount = 0
    Qt.callLater(maybeDownloadRadarFrames)
  }
  // All of a key's frames count as downloaded only once every one is on
  // disk; until then it is retried with a growing delay.
  property int radarRetryCount: 0
  Timer {
    id: radarRetry
    interval: Math.min(60000, 5000 * Math.pow(2, Math.max(0, root.radarRetryCount - 1)))
    onTriggered: root.maybeDownloadRadarFrames()
  }
  property string radarDoneKey: ""

  function maybeDownloadRadarFrames() {
    if (!radarActive || radarKey === "" || radarDownloadProc.running || radarRetry.running
        || Date.now() < backoffUntil.br) return
    if (radarDoneKey === radarKey) {
      publishRadarLoop()
      return
    }
    radarDownloadProc.key = radarKey
    radarDownloadProc.command = Model.radarDownloadCommand(tilesDir, radarData.frames, userAgent)
    radarDownloadProc.running = true
  }

  // Published loops are immutable and always complete (Buienradar's whole
  // timeline is a handful of images, so unlike the old tile system there is
  // no partial/progressive loop to assemble).
  property var shownLoop: null
  readonly property bool shownValid: shownLoop !== null && shownLoop.key === radarKey
  readonly property var displayLoop: shownValid ? shownLoop : radarData
  readonly property var imageLoop: shownValid ? shownLoop : null
  readonly property int playLimit: shownValid ? shownLoop.frames.length : 0
  readonly property bool playing: shownValid && playLimit > 1
  readonly property var currentFrame: shownValid ? shownLoop.frames[Math.min(radarFrame, playLimit - 1)] : null

  function publishRadarLoop() {
    if (!radarData.frames.length) return
    var wasValid = shownValid
    var next = 0
    if (wasValid) {
      var at = Math.min(radarFrame, shownLoop.frames.length - 1)
      next = Model.radarFrameAt(radarData.frames, shownLoop.frames[at].timeMs)
    }
    shownLoop = { frames: radarData.frames, nowIndex: radarData.nowIndex, key: radarKey }
    if (!wasValid || next !== radarFrame) radarPlayhead = { frame: next, tick: radarPlayhead.tick + 1 }
  }

  // Animation: 250 ms per 5-minute frame, looping straight from the last
  // forecast frame back to the first. Click the map to pause.
  property var radarPlayhead: ({ frame: 0, tick: 0 })
  readonly property int radarFrame: radarPlayhead.frame
  property bool radarPaused: false

  function togglePause() {
    radarPaused = !radarPaused
  }

  // Scrubbing (the ruler on the map, or , and .): show a frame and pause.
  function seekFrame(index) {
    var n = displayLoop.frames.length
    if (n <= 0) return
    radarPlayhead = { frame: Math.max(0, Math.min(n - 1, index)), tick: radarPlayhead.tick }
    radarPaused = true
  }

  function stepFrame(delta) {
    seekFrame(Math.min(radarFrame, displayLoop.frames.length - 1) + delta)
  }

  // The panel reports when the images for this exact loop and frame are
  // decoded; until then playback holds rather than skipping a frame.
  readonly property string radarToken: (shownValid ? shownLoop.key : "") + "|" + radarPlayhead.frame + "|" + radarPlayhead.tick
  property string radarReadyToken: ""
  property bool radarReadyImages: false
  readonly property bool radarImagesReady: radarReadyToken === radarToken && radarReadyImages

  function radarImagesPrepared(token, ready) {
    if (token !== radarToken) return
    radarReadyToken = token
    radarReadyImages = ready
  }

  // ---------------------------------------------------------------- IPC

  // Keeps the built-in widget's target, so `omarchy-shell omarchy.weather …`
  // keybinds keep working. Opening goes through the shell, which picks the
  // bar widget on the focused monitor; commands for the panel itself (radar,
  // edit) are handed to whichever panel opens (takePendingAction).
  property string pendingAction: ""
  signal panelCommand(string name)

  function takePendingAction() {
    var action = pendingAction
    pendingAction = ""
    return action
  }

  function openPanelWith(action) {
    if (shell && shell.isPluginOpen(pluginId)) {
      panelCommand(action)
      return
    }
    pendingAction = action
    if (shell) shell.summon(pluginId)
  }

  IpcHandler {
    target: "omarchy.weather"
    function open(): void { if (root.shell) root.shell.summon(root.pluginId) }
    function show(): void { if (root.shell) root.shell.summon(root.pluginId) }
    function close(): void { if (root.shell) root.shell.hide(root.pluginId) }
    function hide(): void { if (root.shell) root.shell.hide(root.pluginId) }
    function toggle(): void { if (root.shell) root.shell.toggle(root.pluginId) }
    function edit(): void { root.openPanelWith("edit") }
    function radar(): void { root.openPanelWith("radar") }
    function refresh(): void { root.refresh(true) }
    function mapZoom(step: int): void { root.setRadarZoom(step) }
    // Switch to the next or previous favourite place.
    function favorite(direction: string): void { root.stepFavorite(direction === "previous" ? -1 : 1) }
    // For scripts: "Alkmaar · Helder 12° · Wind 2 m/s Z · …" and "12°".
    function summary(): string { return Model.summaryText(root.view) }
    function temperature(): string {
      return root.view.ready && root.view.current.temp !== null ? root.view.current.temp + "°" : ""
    }
  }

  // ---------------------------------------------------------------- files

  FileView {
    id: locationFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/settings/weather.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.setLocationIfChanged(Model.parseLocationFile(text()))
    onLoadFailed: root.setLocationIfChanged(Model.parseLocationFile(""))
  }

  function setLocationIfChanged(next) {
    if (next.name === location.name && next.latitude === location.latitude && next.longitude === location.longitude) return
    location = next
  }

  // The first read can race shell startup (seen with the built-in); one
  // delayed reload self-corrects and is a no-op otherwise.
  Timer {
    interval: 1500
    running: true
    onTriggered: locationFile.reload()
  }

  FileView {
    id: favoritesFile
    path: root.favoritesPath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.favorites = Model.parseFavorites(text())
  }

  Process {
    id: mkdirProc
    // The settings folder too, for the favourites file.
    command: ["mkdir", "-p", root.cacheDir, Quickshell.env("HOME") + "/.local/state/omarchy/settings"]
    running: true
    onExited: cacheFile.path = root.cacheDir + "/cache.json"
  }

  // Only this service writes it, so there is nothing to watch.
  FileView {
    id: cacheFile
    atomicWrites: true
    printErrors: false
    onLoaded: {
      var parsed = null
      try { parsed = JSON.parse(text()) } catch (e) { parsed = null }
      root.cache = parsed && typeof parsed === "object" ? parsed : ({})
      root.cacheLoaded = true
      root.rebuild()
      root.maybeFetch(false)
    }
    onLoadFailed: {
      if (root.cacheLoaded) return
      root.cache = ({})
      root.cacheLoaded = true
      root.rebuild()
      root.maybeFetch(false)
    }
  }

  // ---------------------------------------------------------------- processes

  // Inline components can use this file's ids (Quickshell guide).
  component FetchProcess: Process {
    id: fetchProc
    property string kind: ""
    property string url: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.handleResponse(fetchProc.kind, fetchProc.url, text)
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") console.warn("netherlands-weather/" + fetchProc.kind + ": " + text.trim())
    }
  }

  FetchProcess { id: forecastProc; kind: "forecast" }
  FetchProcess { id: nowcastProc; kind: "nowcast" }
  FetchProcess { id: sunProc; kind: "sun" }
  FetchProcess { id: moonProc; kind: "moon" }
  FetchProcess { id: radarProc; kind: "radar" }

  // Prints two numbers (see Model.radarDownloadCommand). The next step
  // starts once the process has exited: its output can end while it still
  // counts as running.
  component TileProcess: Process {
    id: tileProc
    property string key: ""
    signal finished(string key, bool ok, int first, int second)
    signal idle()
    onRunningChanged: if (!running) Qt.callLater(tileProc.idle)
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var n = text.trim().split(/\s+/)
        tileProc.finished(tileProc.key, n.length === 2, parseInt(n[0], 10) || 0, parseInt(n[1], 10) || 0)
      }
    }
  }

  TileProcess {
    id: radarDownloadProc
    onFinished: (key, ok, fetched, missing) => {
      console.log("netherlands-weather: radar frames, " + fetched + " fetched" + (missing ? ", " + missing + " missing" : ""))
      if (!ok || missing > 0) {
        root.radarRetryCount++
        radarRetry.restart()
      } else {
        root.radarRetryCount = 0
        root.radarDoneKey = key
        root.publishRadarLoop()
      }
    }
    onIdle: root.maybeDownloadRadarFrames()
  }

  Process {
    id: geocodeProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var searching = root.geocodePendingQuery !== ""
        root.locationSuggestions = searching ? Model.parseGeocodingResults(text) : []
        root.geocodeSearched = searching
        if (searching && root.geocodePendingQuery !== root.geocodeActiveQuery) Qt.callLater(root.startGeocode)
      }
    }
  }

  Process {
    id: locationSaveProc
    onExited: function(exitCode) {
      if (exitCode !== 0) console.warn("netherlands-weather: omarchy-weather-location failed (" + exitCode + ")")
      locationFile.reload()
    }
  }

  // ---------------------------------------------------------------- timers

  // Every minute, on the minute (SystemClock updates within 50 ms of the
  // wall clock): rebuild so hour rows roll over exactly on the hour, and
  // fetch whatever is due (cheap: no request unless Expires has passed).
  SystemClock {
    precision: SystemClock.Minutes
    onDateChanged: {
      root.radarClockMs = Date.now()
      root.rebuild()
      root.maybeFetch(false)
    }
  }

  // The radar animation (one frame counter for every panel): one frame per
  // tick, 250 ms each. A frame whose images are still decoding holds
  // instead of being skipped.
  Timer {
    interval: 250
    repeat: true
    running: root.radarActive && root.playing && !root.radarPaused
    onTriggered: {
      if (!root.radarImagesReady) return
      var next = Model.radarStep(root.radarFrame, root.radarPlayhead.tick, root.shownLoop.frames.length)
      if (next.tick === root.radarPlayhead.tick) return
      root.radarPlayhead = next
    }
  }
}
