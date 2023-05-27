# Bilingual Mediasoup Server

A Server for Bilingual


## Dependencies

* [Mediasoup v3 requirements](https://mediasoup.org/documentation/v3/mediasoup/installation/#requirements)
* Node.js >= v8.6

## Run

```
# create and modify the configuration
# make sure you set the proper IP for mediasoup.webRtcTransport.listenIps
cp config.example.js config.js
nano config.js

# install dependencies and build mediasoup
npm install

# create the client bundle and start the server app
npm start
```
