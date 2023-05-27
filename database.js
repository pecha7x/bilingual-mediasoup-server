const sqlite3 = require('sqlite3').verbose();
const DBSOURCE = 'db.sqlite';
const config = require('./config');

const ACTIVE_PORTS_TABLE_NAME = 'recording_active_ports';
const AVAILABLE_PORTS = Array.from(
  { length: config.mediasoup.recording.rtpRecordingMaxPort - config.mediasoup.recording.rtpRecordingMinPort },
  (_, i) => config.mediasoup.recording.rtpRecordingMinPort + i
);

const db = new sqlite3.Database(DBSOURCE, (err) => {
  if (err) {
    console.error(err.message);
    throw err;
  } else {
    console.log('Connected to the SQlite database.');
    
    // yeah we can use "CREATE TABLE if not exists", but also need to seed the table once
    db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='recording_active_ports'", [], (err, rows) => {
      if (err) {
        console.error(err.message);
        return;
      }
      
      if (rows.length === 0) {
        db.run(
          `CREATE TABLE ${ACTIVE_PORTS_TABLE_NAME} (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           value INTEGER UNIQUE,
           kind TEXT,
           session_id TEXT,
           locked_at DATETIME,
           CONSTRAINT value_unique UNIQUE (value),
           CONSTRAINT kind_of_session_unique UNIQUE (session_id, kind)
          )`, function (err, _result) {
            if (err) {
              console.error(err.message);
              throw(err);
            }

            AVAILABLE_PORTS.forEach((port) => {
              const query = `INSERT INTO ${ACTIVE_PORTS_TABLE_NAME} (value) VALUES (?)`;
              db.run(query, [port], function (err, _result) {
                if (err) {
                  console.error(err.message);
                  throw(err);
                }
              });
            });
          }
        );
      }
    });
  }
});


module.exports = { db, ACTIVE_PORTS_TABLE_NAME };
