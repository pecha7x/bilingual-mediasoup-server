const fs = require('fs');
const config = require('../config');
const Process = require('child_process');
const { createSDP, deleteSDP } = require('./recording/SDPConnector');
const { processVideo } = require('./recording/VideoProcessing');

module.exports = class Peer {
  constructor(socket_id, name, room_id) {
    this.id                = socket_id;
    this.name              = name;
    this.room_id           = room_id;
    this.transports        = new Map();
    this.consumers         = new Map();
    this.producers         = new Map();
    this.audioRtpTransport = null;
    this.videoRtpTransport = null;
    this.audioRtpConsumer  = null;
    this.videoRtpConsumer  = null;
    this.recProcess        = null;
    this.recOutputPath     = null;
  }

  addTransport(transport) {
    this.transports.set(transport.id, transport)
  }

  async connectTransport(transport_id, dtlsParameters) {
    if (!this.transports.has(transport_id)) return

    await this.transports.get(transport_id).connect({
      dtlsParameters: dtlsParameters
    })
  }

  async createProducer(producerTransportId, rtpParameters, kind) {
    //TODO handle null errors
    let producer = await this.transports.get(producerTransportId).produce({
      kind,
      rtpParameters
    })

    this.producers.set(producer.id, producer)

    producer.on(
      'transportclose',
      function () {
        console.log('Producer transport close', { name: `${this.name}`, consumer_id: `${producer.id}` })
        producer.close()
        this.producers.delete(producer.id)
      }.bind(this)
    )

    return producer
  }

  async createConsumer(consumer_transport_id, producer_id, rtpCapabilities) {
    let consumerTransport = this.transports.get(consumer_transport_id)

    let consumer = null
    try {
      consumer = await consumerTransport.consume({
        producerId: producer_id,
        rtpCapabilities,
        paused: false
      })
    } catch (error) {
      console.error('Consume failed', error)
      return
    }

    if (consumer.type === 'simulcast') {
      await consumer.setPreferredLayers({
        spatialLayer: 3,
        temporalLayer: 3
      })
    } //https://www.w3.org/TR/webrtc-svc/

    this.consumers.set(consumer.id, consumer)

    consumer.on(
      'transportclose',
      function () {
        console.log('Consumer transport close', { name: `${this.name}`, consumer_id: `${consumer.id}` })
        this.consumers.delete(consumer.id)
      }.bind(this)
    )

    return {
      consumer,
      params: {
        producerId: producer_id,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused
      }
    }
  }

  closeProducer(producer_id) {
    try {
      this.producers.get(producer_id).close()
    } catch (e) {
      console.warn(e)
    }

    this.producers.delete(producer_id)
  }

  getProducer(producer_id) {
    return this.producers.get(producer_id)
  }

  getProducerByKind(kind) {
    if (this.producers.size === 0) {
      return null;
    }

    return Array.from(this.producers.values()).filter((producer) => producer.kind === kind)[0];
  }

  close() {
    this.transports.forEach((transport) => transport.close());
    this.stopMediasoupRtp();
  }

  removeConsumer(consumer_id) {
    this.consumers.delete(consumer_id)
  }

  async createRtpTransportAndConsumer(kind, router, sdpRecordingConfig) {
    const producer = this.getProducerByKind(kind);
    if (!producer) {
      return null;
    }

    const rtpTransport = await router.createPlainTransport({
      comedia: false,
      rtcpMux: false,
      ...config.mediasoup.plainTransport,
    });
    this[`${kind}RtpTransport`] = rtpTransport;

    await rtpTransport.connect({
      ip: config.mediasoup.recording.ip,
      port: sdpRecordingConfig.ports[kind],
      rtcpPort: sdpRecordingConfig.ports[`${kind}Rtcp`],
    });

    const rtpConsumer = await rtpTransport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
    });
    this[`${kind}RtpConsumer`] = rtpConsumer;
  }

  async startRecording(roomRouter) {
    const sdpRecordingConfig = await createSDP(this.id);

    await this.createRtpTransportAndConsumer('audio', roomRouter, sdpRecordingConfig);
    await this.createRtpTransportAndConsumer('video', roomRouter, sdpRecordingConfig);
    
    await this.startRecordingGstreamer(sdpRecordingConfig.filePath);

    this.audioRtpConsumer?.resume();
    this.videoRtpConsumer?.resume();
  }

  stopRecording() {
    setTimeout(() => {
      if (this.recProcess) {
        this.recProcess.kill('SIGINT');
      } else {
        this.stopMediasoupRtp();
      }
    }, 1500)
  }

  async startRecordingGstreamer(cmdInputPath) {
    let recResolve;
    const promise = new Promise((res, _rej) => {
      recResolve = res;
    });
  
    // /chat-id/user-id.webm
    const pathToResultFile = `${__dirname}/recording/results/chats/${this.room_id}/peers/${this.name}`;
    fs.mkdirSync(pathToResultFile, { recursive: true });
    this.recOutputPath = `${pathToResultFile}/video.webm`;

    const cmdMux = "webmmux";
    let cmdAudioBranch = "";
    let cmdVideoBranch = "";
  
    if (!!this.audioRtpConsumer) {
      cmdAudioBranch = "demux. ! queue ! rtpopusdepay ! opusparse ! mux.";
    }
  
    if (!!this.videoRtpConsumer) {
      cmdVideoBranch = "demux. ! queue ! rtpvp8depay ! mux.";
    }
  
    const cmdEnv = {
      GST_DEBUG: config.gstreamer.logLevel,
      ...process.env,
    };
    const cmdProgram = "gst-launch-1.0";
    const cmdArgStr = [
      "--eos-on-shutdown",
      `filesrc location=${cmdInputPath}`,
      "! sdpdemux timeout=0 name=demux",
      `${cmdMux} name=mux`,
      `! filesink location=${this.recOutputPath}`,
      // `! s3sink uri=s3://eu-north-1/bilingual-staging-video-calls/${this.id}-${Date.now()}_output-gstreamer-vp8.webm`,
      cmdAudioBranch,
      cmdVideoBranch,
    ]
      .join(" ")
      .trim();
  
    let recProcess = Process.spawn(cmdProgram, cmdArgStr.split(/\s+/), {
      env: cmdEnv,
    });
    this.recProcess = recProcess;
  
    recProcess.on("error", (err) => {
      console.error("Recording process error:", err);
    });
  
    recProcess.on("exit", (code, signal) => {
      console.log("Recording process exit, code: %d, signal: %s", code, signal);
  
      processVideo(this.recOutputPath, this.room_id, this.name);

      this.recProcess = null;
      this.recOutputPath = null;
      this.stopMediasoupRtp(this.id);
  
      if (!signal || signal === "SIGINT") {
        console.log("Recording stopped");
      } else {
        console.warn(
          "Recording process didn't exit cleanly, output file might be corrupt"
        );
      }
    });
  
    recProcess.stdout.on("data", (chunk) => {
      chunk
        .toString()
        .split(/\r?\n/g)
        .filter(Boolean)
        .forEach((line) => {
          if (line.startsWith("Setting pipeline to PLAYING")) {
            setTimeout(() => {
              recResolve();
            }, 1000);
          }
        });
    });
  
    // GStreamer writes its progress logs to stderr
    recProcess.stderr.on("data", (chunk) => {
      chunk
        .toString()
        .split(/\r?\n/g)
        .filter(Boolean) // Filter out empty strings
        .forEach((line) => {
          console.log(line);
        });
    });

    return promise;
  }

  async stopMediasoupRtp() {
    if (this.videoRtpConsumer || this.audioRtpConsumer) {
      setTimeout(deleteSDP, 5000, this.id);
    }

    if (this.audioRtpConsumer) {
      await this.audioRtpConsumer.close();
      await this.audioRtpTransport.close();
      this.audioRtpConsumer = null;
      this.audioRtpTransport = null;
    }
  
    if (this.videoRtpConsumer) {
      await this.videoRtpConsumer.close();
      await this.videoRtpTransport.close();
      this.videoRtpConsumer = null;
      this.videoRtpTransport = null;
    }
  }
}
