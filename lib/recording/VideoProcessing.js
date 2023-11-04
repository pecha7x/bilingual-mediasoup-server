require('dotenv').config();

const { Queue } = require('bullmq');
const { uploadToS3 } = require('./S3VideoUploader');

const redisConfiguration = {
  connection: {
    host:     process.env.REDIS_HOST,
    port:     process.env.REDIS_PORT,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD
  }
};
const videosQueue = new Queue('chatVideo', redisConfiguration);

async function processVideo(filePath, chatId, userId) {
  const uploadResult = await uploadToS3(filePath);
  console.log('processVideo/uploadResult', uploadResult)
  await videosQueue.add('video', { chatId, userId });
};

module.exports = { processVideo };
