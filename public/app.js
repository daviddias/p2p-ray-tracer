/* global location */
'use strict'

const IPFS = require('ipfs')
const fs = require('fs')
const srt = require('simple-raytracer')
const PeerId = require('peer-id')
const all = require('it-all')
const uint8ArrayConcat = require('uint8arrays/concat')
const uint8ArrayFromString = require('uint8arrays/from-string')

// Misc
const $allDisabledButtons = document.querySelectorAll('button:disabled')
const $allDisabledInputs = document.querySelectorAll('input:disabled')
const $allDisabledElements = document.querySelectorAll('.disabled')

let node
let info

/* ===========================================================================
   Start the IPFS node
   =========================================================================== */

const $nodeId = document.querySelector('.node-id')
const $nodeAddresses = document.querySelector('.node-addresses')
const $logs = document.querySelector('#logs')

async function startNode () {
  if (!node) {
    const peerId = await PeerId.create({ bits: 256, keyType: 'ed25519' })
    node = await IPFS.create({
      init: {
        privateKey: peerId
      },
      repo: 'ipfs-' + Math.random(),
      config: {
        Addresses: {
          Swarm: [
            // This is a public webrtc-star server
            '/dns4/wrtc-star1.par.dwebops.pub/tcp/443/wss/p2p-webrtc-star',
            '/dns4/wrtc-star2.sjc.dwebops.pub/tcp/443/wss/p2p-webrtc-star'
            // '/ip4/127.0.0.1/tcp/13579/wss/p2p-webrtc-star'
          ]
        },
        // If you want to connect to the public bootstrap nodes, remove the next line
        Bootstrap: []
      }
    })

    try {
      info = await node.id()

      const addressesHtml = info.addresses.map((address) => {
        return `<li><pre>${address}</pre></li>`
      }).join('')
      $nodeId.innerText = info.id
      $nodeAddresses.innerHTML = addressesHtml
      $allDisabledButtons.forEach(b => { b.disabled = false })
      $allDisabledInputs.forEach(b => { b.disabled = false })
      $allDisabledElements.forEach(el => { el.classList.remove('disabled') })
    } catch (err) {
      return onError(err)
    }

    onSuccess('Node is ready.')

    // Refresh Network Peers
    setInterval(async () => {
      try {
        await refreshPeerList()
      } catch (err) {
        err.message = `Failed to refresh the peer list: ${err.message}`
        onError(err)
      }
    }, 1000)

    // Refresh Workspace Peers
    setInterval(async () => {
      try {
        await refreshWorkspacePeerList()
      } catch (err) {
        err.message = `Failed to refresh the workspace peer list: ${err.message}`
        onError(err)
      }
    }, 1000)

    setInterval(async () => {
      try {
        await sendFileList()
      } catch (err) {
        err.message = `Failed to publish the file list: ${err.message}`
        onError(err)
      }
    }, 10000)

    try {
      await subscribeToWorkspace()
    } catch (err) {
      err.message = `Failed to subscribe to the workspace: ${err.message}`
      return onError(err)
    }

    window.addEventListener('hashchange', async () => {
      try {
        await workspaceUpdated()
      } catch (err) {
        err.message = `Failed to subscribe to the updated workspace: ${err.message}`
        onError(err)
      }
    })
  }
}

/* ===========================================================================
   PubSub
   =========================================================================== */

const messageHandler = (message) => {
  const myNode = info.id.toString()
  const hash = message.data.toString()
  const messageSender = message.from

  // append new files when someone uploads them
  if (myNode !== messageSender && !FILES.includes(hash)) {
    $cidInput.value = hash
    getFile()
  }
}

const publishHash = (hash) => {
  const data = uint8ArrayFromString(hash)
  return node.pubsub.publish(workspace, data)
}

/* ===========================================================================
   Workspace handling
   =========================================================================== */

const $workspace = document.querySelector('#workspace')
const $workspaceInput = $workspace.querySelector('#workspace-input')
const $workspaceBtn = $workspace.querySelector('#workspace-btn')
const $workspacePeersList = $workspace.querySelector('#workspace-peers')

let workspace = (location.hash || 'default-workspace').replace(/^#/, '')

const subscribeToWorkspace = async () => {
  await node.pubsub.subscribe(workspace, messageHandler)
  const msg = `Subscribed to workspace '${workspace}'`
  $logs.innerHTML = msg
}

// unsubscribe from old workspace and re-subscribe to new one
const workspaceUpdated = async () => {
  await node.pubsub.unsubscribe(workspace)
  // clear files from old workspace
  FILES = []
  $fileHistory.innerHTML = ''

  workspace = location.hash.replace(/^#/, '')
  await subscribeToWorkspace()
}

async function refreshWorkspacePeerList () {
  const peers = await node.pubsub.peers(workspace)

  const peersAsHtml = peers.reverse()
    .map((addr) => {
      return `<tr><td>${addr}</td></tr>`
    }).join('')

  $workspacePeersList.innerHTML = peersAsHtml
}


/* ===========================================================================
   Ray Tracing
   =========================================================================== */

const buf = fs.readFileSync('./scenes/pokeball.rt', 'utf8')
const canvas = document.querySelector('#mycanvas')
const $rayTraceLocalButton = document.querySelector('#ray-trace-local-btn')
const $rayTraceDistributedButton = document.querySelector('#ray-trace-distributed-btn')

function rayTraceLocal() {
  const scene = srt.prepareScene.byBuffer(buf)

  // number of units per split (total: N_UNITS * N_UNITS)
  const N_UNITS = 50

  // break into separete tasks
  const tasks = srt.prepareTasks({
    split: N_UNITS,
    width: scene.global.width,
    height: scene.global.height
  })

  const startTime = Date.now()

  // take each task and execute a ray trace on the world with it
  const results = tasks.map((task) => {
    return {
      begin_x: task.begin_x,
      end_x: task.end_x,
      begin_y: task.begin_y,
      end_y: task.end_y,
      animation: task.animation,
      data: srt.runTask(scene, task).data
    }
  })

  const endTime = Date.now()
  onSuccess('Ray Tracing: ' + (endTime - startTime) + ' ms')

  // prepare our canvas
  const canvasContext = canvas.getContext('2d')
  canvas.width = canvas.width // clear canvas
  canvas.width = scene.global.width
  canvas.height = scene.global.height

  // create the image for one frame
  const frameN = 0
  const frames = []
  frames[frameN] = canvasContext.createImageData(canvas.width, canvas.height)

  // get each result of the ray trace and inject on canvas obj
  results.map(function (r) {
    let i = 0
    for (let y = r.begin_y; y < r.end_y; y++) {
      for (let x = r.begin_x; x < r.end_x; x++) {
        let index = (y * canvas.width + x) * 4
        frames[frameN].data[index++] = r.data[i++]
        frames[frameN].data[index++] = r.data[i++]
        frames[frameN].data[index++] = r.data[i++]
        frames[frameN].data[index++] = 255
      }
    }
  })

  // reload canvas with new data
  canvasContext.putImageData(frames[frameN], 0, 0)
}


/* ===========================================================================
   Network Peers handling
   =========================================================================== */

// Network Peers
const $networkPeers = document.querySelector('#network-peers')
const $peersList = $networkPeers.querySelector('#connected-peers')
const $multiaddrInput = document.querySelector('#multiaddr-input')
const $connectButton = document.querySelector('#peer-btn')

async function connectToPeer (event) {
  const multiaddr = $multiaddrInput.value

  if (!multiaddr) {
    throw new Error('No multiaddr was inserted.')
  }

  await node.swarm.connect(multiaddr)

  onSuccess('Successfully connected to peer.')
  $multiaddrInput.value = ''
}

async function refreshPeerList () {
  const peers = await node.swarm.peers()

  const peersAsHtml = peers.reverse()
    .map((peer) => {
      if (!peer.addr) {
        return 'error: Peer did not contain valid address'
      }
      const addr = peer.addr.toString()

      if (addr.indexOf('/p2p/') >= 0) {
        return addr
      } else {
        return addr + '/p2p/' + peer.peer
      }
    })
    .map((addr) => {
      return `<tr><td>${addr}</td></tr>`
    }).join('')

  $peersList.innerHTML = peersAsHtml
}

/* ===========================================================================
   Files handling
   =========================================================================== */

// Files
const $cidInput = document.querySelector('#cid-input')
const $fetchButton = document.querySelector('#fetch-btn')
const $dragContainer = document.querySelector('#drag-container')
const $progressBar = document.querySelector('#progress-bar')
const $fileHistory = document.querySelector('#file-history tbody')
const $emptyRow = document.querySelector('.empty-row')

let FILES = []
let fileSize = 0

const sendFileList = () => Promise.all(FILES.map(publishHash))

const updateProgress = (bytesLoaded) => {
  const percent = 100 - ((bytesLoaded / fileSize) * 100)

  $progressBar.style.transform = `translateX(${-percent}%)`
}

const resetProgress = () => {
  $progressBar.style.transform = 'translateX(-100%)'
}

function appendFile (name, hash, size, data) {
  const file = new window.Blob([data], { type: 'application/octet-binary' })
  const url = window.URL.createObjectURL(file)
  const row = document.createElement('tr')

  const nameCell = document.createElement('td')
  nameCell.innerHTML = name

  const hashCell = document.createElement('td')
  hashCell.innerHTML = hash

  const sizeCell = document.createElement('td')
  sizeCell.innerText = size

  const downloadCell = document.createElement('td')
  const link = document.createElement('a')
  link.setAttribute('href', url)
  link.setAttribute('download', name)
  link.innerHTML = '<img width=20 class="table-action" src="assets/download.svg" alt="Download" />'
  downloadCell.appendChild(link)

  row.appendChild(nameCell)
  row.appendChild(hashCell)
  row.appendChild(sizeCell)
  row.appendChild(downloadCell)

  $fileHistory.insertBefore(row, $fileHistory.firstChild)

  return publishHash(hash)
}

async function getFile () {
  const hash = $cidInput.value

  $cidInput.value = ''

  if (!hash) {
    return onError('No CID was inserted.')
  } else if (FILES.includes(hash)) {
    return onSuccess('The file is already in the current workspace.')
  }

  FILES.push(hash)

  for await (const file of node.get(hash)) {
    if (file.content) {
      const content = uint8ArrayConcat(await all(file.content))

      await appendFile(file.name, hash, file.size, content)
      onSuccess(`The ${file.name} file was added.`)
      $emptyRow.style.display = 'none'
    }
  }
}

/* ===========================================================================
  Drag & Drop
  =========================================================================== */

const onDragEnter = () => $dragContainer.classList.add('dragging')

const onDragLeave = () => $dragContainer.classList.remove('dragging')

async function onDrop (event) {
  onDragLeave()
  event.preventDefault()

  const files = Array.from(event.dataTransfer.files)

  for (const file of files) {
    fileSize = file.size // Note: fileSize is used by updateProgress

    const fileAdded = await node.add({
      path: file.name,
      content: file
    }, {
      wrapWithDirectory: true,
      progress: updateProgress
    })

    // As we are wrapping the content we use that hash to keep
    // the original file name when adding it to the table
    $cidInput.value = fileAdded.cid.toString()

    resetProgress()
    await getFile()
  }
}

/* ===========================================================================
   Error handling
   =========================================================================== */

function onSuccess (msg) {
  $logs.classList.add('success')
  $logs.innerHTML = msg
}

function onError (err) {
  console.log(err)
  let msg = 'An error occured, check the dev console'

  if (err.stack !== undefined) {
    msg = err.stack
  } else if (typeof err === 'string') {
    msg = err
  }

  $logs.classList.remove('success')
  $logs.innerHTML = msg
}

window.onerror = onError

/* ===========================================================================
   Boot the app
   =========================================================================== */

const startApplication = () => {
  // Setup event listeners
  $dragContainer.addEventListener('dragenter', onDragEnter)
  $dragContainer.addEventListener('dragover', onDragEnter)
  $dragContainer.addEventListener('drop', async (ev) => {
    try {
      await onDrop(ev)
    } catch (err) {
      err.message = `Failed to add files: ${err.message}`
      onError(err)
    }
  })
  $dragContainer.addEventListener('dragleave', onDragLeave)
  $fetchButton.addEventListener('click', async () => {
    try {
      await getFile()
    } catch (err) {
      err.message = `Failed to fetch CID: ${err.message}`
      onError(err)
    }
  })
  $connectButton.addEventListener('click', async () => {
    try {
      await connectToPeer()
    } catch (err) {
      err.message = `Failed to connect to peer: ${err.message}`
      onError(err)
    }
  })

  $rayTraceLocalButton.addEventListener('click', () => {
    try {
      rayTraceLocal()
    } catch (err) {
      err.message = `Failed to run local ray trace: ${err.message}`
      onError(err)
    }
  })

  $rayTraceDistributedButton.addEventListener('click', () => {
    try {
      console.log('not implemented yet')
    } catch (err) {
      err.message = `Failed to run distributed ray trace: ${err.message}`
      onError(err)
    }
  })



  $workspaceBtn.addEventListener('click', () => {
    window.location.hash = $workspaceInput.value
  })

  startNode()
}

startApplication()
