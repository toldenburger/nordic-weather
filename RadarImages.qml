pragma ComponentBehavior: Bound
import QtQuick
import "Model.js" as Model

// Draws Buienradar's radar frames directly: they are already fully
// rendered (basemap and rain baked in by Buienradar itself), so unlike the
// old tile system there is no shader pass here. Three rotating Image slots
// give the next frame a whole source-frame interval to decode before it is
// shown, so advancing the loop every 250 ms never flashes an empty frame.
// A replacement loop gets its own short-lived staging set, decoded
// invisibly; the old set stays on screen until the new one is ready.
Item {
  id: root

  property var loop: null
  property var playhead: ({ frame: 0, tick: 0 })
  property string directory: ""
  property string token: ""
  property var front: null
  property var staging: null
  readonly property string snapshotKey: loop ? loop.key : ""

  readonly property bool ready: front !== null && front.snapshotKey === snapshotKey && front.imagesReady
    && front.playhead.frame === playhead.frame && front.playhead.tick === playhead.tick

  signal prepared(string token, bool ready)
  // A frame's image file couldn't be loaded (e.g. cleaned from the cache).
  signal failed()

  function report() { prepared(token, ready) }
  onTokenChanged: Qt.callLater(report)
  onReadyChanged: Qt.callLater(report)
  onLoopChanged: {
    var key = snapshotKey
    if (front && front.snapshotKey === key) front.loop = loop
    if (staging && staging.snapshotKey === key) staging.loop = loop
    Qt.callLater(synchronize)
  }
  // A step reaches the drawing at once, in the same update as the ruler and
  // the time label.
  onPlayheadChanged: {
    if (front && front.snapshotKey === snapshotKey) front.playhead = playhead
    if (staging && staging.snapshotKey === snapshotKey) staging.playhead = playhead
    if (!front || front.snapshotKey !== snapshotKey) Qt.callLater(synchronize)
  }

  function synchronize() {
    if (!loop || !loop.frames.length) {
      if (staging) staging.destroy()
      if (front) front.destroy()
      staging = null
      front = null
      return
    }
    if (front && front.snapshotKey === snapshotKey) {
      if (staging) { staging.destroy(); staging = null }
      front.loop = loop
      front.playhead = playhead
    } else {
      if (staging && staging.snapshotKey !== snapshotKey) { staging.destroy(); staging = null }
      if (!staging) staging = layerComponent.createObject(root, { loop: loop, snapshotKey: snapshotKey, playhead: playhead })
      else staging.playhead = playhead
      promote()
    }
    Qt.callLater(report)
  }

  function promote() {
    if (!staging || staging.snapshotKey !== snapshotKey || !staging.imagesReady) return
    var old = front
    front = staging
    staging = null
    if (old) old.destroy()
    Qt.callLater(report)
  }

  Component {
    id: layerComponent
    Item {
      id: imageSet
      required property var loop
      required property string snapshotKey
      required property var playhead
      anchors.fill: parent
      // Only the front set (once promoted) is ever shown; a staging set
      // decodes invisibly underneath it.
      visible: root.front === imageSet
      // `loop` can go null for a tick while a dropped loop's replacement
      // Item is still being torn down (Qt.callLater(synchronize) in the
      // wrapper runs a tick later): read defensively rather than warn.
      readonly property var slots: Model.radarImageSlots(loop ? loop.frames : [], playhead.frame, playhead.tick)
      readonly property var images: [image0, image1, image2]
      readonly property var current: images[slots.current]
      readonly property var upcoming: images[slots.upcoming]
      readonly property bool imagesReady: current.status === Image.Ready && upcoming.status === Image.Ready
      onImagesReadyChanged: Qt.callLater(root.promote)
      readonly property bool imagesFailed: current.status === Image.Error || upcoming.status === Image.Error
      onImagesFailedChanged: if (imagesFailed) root.failed()

      function urlFor(frame) {
        return frame ? "file://" + root.directory + "/" + Model.radarFrameFile(frame) : ""
      }

      component FrameImage: Image {
        required property int slot
        anchors.fill: parent
        visible: slot === imageSet.slots.current
        fillMode: Image.PreserveAspectFit
        smooth: false
        cache: false
        asynchronous: true
        retainWhileLoading: true
        source: imageSet.urlFor(imageSet.slots.frames[slot])
      }
      FrameImage { id: image0; slot: 0 }
      FrameImage { id: image1; slot: 1 }
      FrameImage { id: image2; slot: 2 }
    }
  }
}
