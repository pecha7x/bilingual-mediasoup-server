require('dotenv').config();

const AWS = require('aws-sdk');
const fs  = require('fs');

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

async function uploadToS3(filePath) {
  const filePathInKeys = filePath.split('/');
  const params = {
    Bucket: process.env.AWS_VIDEOS_BUCKET_NAME,
    Key: `chats/${filePathInKeys[filePathInKeys.length-2]}/peers/${filePathInKeys[filePathInKeys.length-1]}`,
    Body: fs.createReadStream(filePath)
  };
  const res = await s3.upload(params).promise();
  return res;
};

module.exports = { uploadToS3 };
