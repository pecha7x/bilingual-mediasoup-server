const fs = require('fs');
const util = require('util');
const { db, ACTIVE_PORTS_TABLE_NAME } = require('../../database');

async function createSDP(sessionId) {  
  writeFile = util.promisify(fs.writeFile);
  const filePath = `${__dirname}/sdps/input-vp8-${sessionId}.sdp`;

  const portsValues = await getFreePortsForSession(sessionId);

  await writeFile(filePath, SDPString(portsValues));

  return { filePath, ports: portsValues };
};

async function deleteSDP(sessionId) {
  const filePath = `${__dirname}/sdps/input-vp8-${sessionId}.sdp`;

  fs.unlinkSync(filePath);

  return await removePortUsageFromDB(sessionId);
};

function SDPString(ports) {
  const string = `v=0\no=- 0 0 IN IP4 127.0.0.1\ns=-\nc=IN IP4 127.0.0.1\nt=0 0\nm=audio ${ports.audio} RTP/AVPF 111\na=rtcp:${ports.audioRtcp}\na=rtpmap:111 opus/48000/2\na=fmtp:111 minptime=10;useinbandfec=1\nm=video ${ports.video} RTP/AVPF 96\na=rtcp:${ports.videoRtcp}\na=rtpmap:96 VP8/90000`;

  return string;
};

async function getFreePortsForSession(sessionId) {
  let freePorts = {};

  for await (const portKind of ['audio', 'audioRtcp', 'video', 'videoRtcp']) {
    const portValue = await writePortUsageToDB(portKind, sessionId);
    freePorts[portKind] = portValue;
  }

  return (freePorts);
};

function removePortUsageFromDB(sessionId) {
  return new Promise((resolve, reject) => {
    return db.run(
      `UPDATE ${ACTIVE_PORTS_TABLE_NAME} SET kind = NULL, session_id = NULL, locked_at = NULL WHERE session_id = ?`,
      sessionId,
      function (err, _result) {
        if (err){
          console.error(err.message);
          return reject(err.message);
        }

        return resolve(true);
      }
    );
  });
};

function writePortUsageToDB(portKind, sessionId) {
  return new Promise((resolve, reject) => {
    const query = `
      UPDATE ${ACTIVE_PORTS_TABLE_NAME} SET
        kind = ?, 
        session_id = ?,
        locked_at = ?
      WHERE rowid=(SELECT MIN(rowid) FROM ${ACTIVE_PORTS_TABLE_NAME} WHERE locked_at IS NULL)
    `;

    db.run(query, [portKind, sessionId, new Date().toISOString()], function (err) {
      if (err) {
        console.error(err.message);
        return reject(err.message);
      }
     
      return db.all(`SELECT value FROM ${ACTIVE_PORTS_TABLE_NAME} WHERE kind=? AND session_id=? LIMIT 1`, [portKind, sessionId], (err, rows) => {
        if (err) {
          console.error(err.message);
          return reject(err.message);
        }

        return resolve(rows[0]?.value);
      });
    });
  });
};

module.exports = { createSDP, deleteSDP };
