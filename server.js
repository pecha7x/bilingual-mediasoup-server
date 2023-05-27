const mediasoup = require('mediasoup');
const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIO = require('socket.io');
const config = require('./config');
const Room = require('./lib/Room');
const Peer = require('./lib/Peer');

// Global variables
let webServer;
let socketServer;
let expressApp;

(async () => {
  try {
    await runExpressApp();
    await runWebServer();
    await runSocketServer();
    await runMediasoupWorkers();
  } catch (err) {
    console.error(err);
  }
})();

async function runExpressApp() {
  expressApp = express();

  expressApp.use((error, _req, res, next) => {
    if (error) {
      console.warn('Express app error,', error.message);

      error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

      res.statusMessage = error.message;
      res.status(error.status).send(String(error));
    } else {
      next();
    }
  });

  expressApp.get('/', (_req, res) => {
    res.send('Running');
  });
}

async function runWebServer() {
  const { sslKey, sslCrt } = config;
  if (!fs.existsSync(sslKey) || !fs.existsSync(sslCrt)) {
    console.error('SSL files are not found. check your config.js file');
    process.exit(0);
  }
  const tls = {
    key: fs.readFileSync(config.sslKey, 'utf-8'),
    cert: fs.readFileSync(config.sslCrt, 'utf-8')
  };
  webServer = https.createServer(tls, expressApp);
  webServer.on('error', (err) => {
    console.error('starting web server failed:', err.message);
  });

  await new Promise((resolve) => {
    const { listenIp, listenPort } = config;
    webServer.listen(listenPort, listenIp, () => {
      const listenIps = config.mediasoup.webRtcTransport.listenIps[0];
      const ip = listenIps.announcedIp || listenIps.ip;
      console.log(`server is running - https://${ip}:${listenPort}`);
      resolve();
    });
  });
}

async function runSocketServer() {
  socketServer = socketIO(webServer, {
    serveClient: false,
    path: '/server',
    log: false
  });
  
  socketServer.on('connection', (socket) => {
    console.log('client connected');

    socket.on('connect_error', (err) => {
      console.error(`connect_error due to ${err.message}`);
    });

    socket.on('createRoom', async ({ room_id }, callback) => {
      if (roomList.has(room_id)) {
        callback('already exists')
      } else {
        let worker = await getMediasoupWorker();
        roomList.set(room_id, new Room(room_id, worker, socketServer));
        callback(room_id);
      }
    });

    socket.on('removeRoom', async ({ room_id }, callback) => {
      if (!roomList.has(room_id)) {
        callback('Room does not exist')
      } else {
        console.log('Remove room', { room_id: room_id });
        // TODO: need remove the room from roomList and make the worker to free for usage
        // roomList.delete(room_id);
        callback('The room removed')
      }
    });
  
    socket.on('join', ({ room_id, name }, callback) => {  
      if (!roomList.has(room_id)) {
        return callback({
          error: 'Room does not exist'
        });
      }

      const room = roomList.get(room_id);
      room.addPeer(new Peer(socket.id, name, room_id));
      socket.room_id = room_id;
  
      callback(room.toJson());
    });
  
    socket.on('getProducers', () => {
      if (!roomList.has(socket.room_id)) return;

      const room = roomList.get(socket.room_id);
      console.log('Get producers', { name: `${room.getPeers().get(socket.id).name}` });
      
      let producerList = room.getProducerListForPeer(socket.id)
      socket.emit('newProducers', producerList)
    });
  
    socket.on('getRouterRtpCapabilities', (_, callback) => {
      const room = roomList.get(socket.room_id);
  
      try {
        console.log('Get RouterRtpCapabilities', { name: `${room.getPeers().get(socket.id).name}` });
        callback(room.getRtpCapabilities());
      } catch (e) {
        callback({
          error: e.message
        })
      }
    });
  
    socket.on('createWebRtcTransport', async (_, callback) => {
      const room = roomList.get(socket.room_id);
  
      try {
        console.log('Create webrtc transport', { name: `${room.getPeers().get(socket.id).name}` });
        const { params } = await room.createWebRtcTransport(socket.id);
        callback(params)
      } catch (err) {
        console.error(err)
        callback({
          error: err.message
        })
      }
    });
  
    socket.on('connectTransport', async ({ transport_id, dtlsParameters }, callback) => {
      if (!roomList.has(socket.room_id)) return;

      const room = roomList.get(socket.room_id);
      console.log('Connect transport', { name: `${room.getPeers().get(socket.id).name}` });
      await room.connectPeerTransport(socket.id, transport_id, dtlsParameters);

      callback('success');
    });
  
    socket.on('produce', async ({ kind, rtpParameters, producerTransportId }, callback) => {
      if (!roomList.has(socket.room_id)) {
        return callback({ error: 'not is a room' })
      }
  
      const room = roomList.get(socket.room_id);
      let producer_id = await room.produce(socket.id, producerTransportId, rtpParameters, kind);
  
      console.log('Produce', {
        type: `${kind}`,
        name: `${room.getPeers().get(socket.id).name}`,
        id: `${producer_id}`
      });
  
      callback({ producer_id });
    });
  
    socket.on('consume', async ({ consumerTransportId, producerId, rtpCapabilities }, callback) => {
      if (!roomList.has(socket.room_id)) {
        return callback({ error: 'not is a room' })
      }

      try {
        const room = roomList.get(socket.room_id);
        let params = await room.consume(socket.id, consumerTransportId, producerId, rtpCapabilities);
    
        console.log('Consuming', {
          name: `${room && room.getPeers().get(socket.id).name}`,
          producer_id: `${producerId}`,
          consumer_id: `${params.id}`
        })

        callback(params);
      } catch (err) {
        console.error(err)
        callback({
          error: err.message
        })
      }
    });
  
    socket.on('resume', async (_data, callback) => {
      await consumer.resume();

      callback();
    });
  
    socket.on('getMyRoomInfo', (_, cb) => {
      cb(roomList.get(socket.room_id).toJson());
    });
  
    socket.on('disconnect', () => {
      if (!socket.room_id) return;

      const room = roomList.get(socket.room_id);
      console.log('Disconnect', { name: `${room && room.getPeers().get(socket.id).name}` });

      roomList.get(socket.room_id).removePeer(socket.id);
    });
  
    socket.on('producerClosed', ({ producer_id }) => {
      const room = roomList.get(socket.room_id);
      console.log('Producer close', { name: `${room && room.getPeers().get(socket.id).name}` });
  
      room.closeProducer(socket.id, producer_id);
    })
  
    socket.on('exitRoom', async (_, callback) => {
      console.log('Exit room', {
        name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
      })
  
      if (!roomList.has(socket.room_id)) {
        callback({
          error: 'not currently in a room'
        })
        return
      }
      // close transports
      await roomList.get(socket.room_id).removePeer(socket.id)
      if (roomList.get(socket.room_id).getPeers().size === 0) {
        console.log('Delete room', socket.room_id);
        roomList.delete(socket.room_id);
      }
  
      socket.room_id = null;
  
      callback('successfully exited room')
    })
  
    // Recording handlers
    socket.on('startRecording', async (_, callback) => {  
      await roomList.get(socket.room_id).startRecording(socket.id);
  
      callback('success');
    });
  
    socket.on('stopRecording', async (_, callback) => {  
      await roomList.get(socket.room_id).stopRecording(socket.id);
  
      callback('success');
    });
  });
}


// all mediasoup workers
let workers = [];
let nextMediasoupWorkerIdx = 0;

/**
 * roomList
 * {
 *  room_id: Room {
 *      id:
 *      router:
 *      peers: {
 *          id:,
 *          name:,
 *          master: [boolean],
 *          transports: [Map],
 *          producers: [Map],
 *          consumers: [Map],
 *          rtpCapabilities:,
 *          audioRtpTransport:,
 *          videoRtpTransport:,
 *          audioRtpConsumer:,
 *          videoRtpConsumer:,
 *          recProcess:
 *      }
 *  }
 * }
 */
let roomList = new Map();

async function runMediasoupWorkers() {
  let { numWorkers } = config.mediasoup

  for (let i = 0; i < numWorkers; i++) {
    let worker = await mediasoup.createWorker({
      logLevel: config.mediasoup.worker.logLevel,
      logTags: config.mediasoup.worker.logTags,
      rtcMinPort: config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: config.mediasoup.worker.rtcMaxPort
    })

    worker.on('died', () => {
      console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid)
      setTimeout(() => process.exit(1), 2000)
    })
    workers.push(worker)

    // log worker resource usage
    /*setInterval(async () => {
            const usage = await worker.getResourceUsage();
            console.info('mediasoup Worker resource usage [pid:%d]: %o', worker.pid, usage);
        }, 120000);*/
  }
};

function getMediasoupWorker() {
  const worker = workers[nextMediasoupWorkerIdx]

  if (++nextMediasoupWorkerIdx === workers.length) nextMediasoupWorkerIdx = 0

  return worker
};

