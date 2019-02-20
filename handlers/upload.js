// eslint-disable-next-line
'use strict';

const AWS = require('aws-sdk')

const Status = require('../models/status')
const Errors = require('../models/errors')

const s3 = new AWS.S3({
  region: process.env.REGION,
  signatureVersion: 'v4',
})

const ddb = new AWS.DynamoDB.DocumentClient({
  region: process.env.REGION,
})

function updateStatus(key, desiredStatus) {
  const stat = Status()
  const indexOfPreviousStatus = stat.getIndex(desiredStatus) - 1

  return new Promise(async (res, rej) => {
    try {
      await ddb.update({
        TableName: process.env.TABLE_NAME,
        Key: {
          [process.env.PARTITION_KEY]: key,
        },
        UpdateExpression: 'add #a :x', // increment by attrb #a by :x
        ConditionExpression: '#a = :y', // only increment if status = the upload signature status
        ExpresstionAttributeNames: {
          '#a': 'status',
        },
        ExpressionAttributeValues: {
          ':x': 1, // increment by 1
          // only increment status if it is currently at the previous step
          // this avoids incrementing twice in a case where this function gets triggered multiple times
          ':y': indexOfPreviousStatus,
        },
      })

      res()
    } catch (e) {
      rej(e)
    }
  })
}

module.exports.handler = async (event, context) => {
  const errs = Errors()

  const SUCCESS = {
    statusCode: 200,
  }

  console.log(event.Records[0])
  const { eventTime } = event.Records[0]
  const { sourceIPAddress } = event.Records[0].requestParameters
  const { name } = event.Records[0].s3.bucket
  const { key, size } = event.Records[0].s3.object
  const metaSize = size.toString(10)

  if (size > process.env.MAX_UPLOAD_SIZE || size === 0) {
    // prevent further processing if the object is larger than the limit (or 0)
    // NOTE: here, you may wish to delete the item. Remember that your function
    // role must have permission to delete items if you want to do this.
    // Also, we return 'SUCCESS' here simply because we don't want to process it anymore
    // if we returned an error, lambda would retry this request a few more times.

    // update the table entry for this code to contain an error.
    // when the user polls for their code, they will be notified of the error, and what type it is

    await ddb.update({
      TableName: process.env.TABLE_NAME,
      Key: {
        [process.env.PARTITION_KEY]: key,
      },
      UpdateExpression: 'set #a = :x',
      ExpresstionAttributeNames: {
        '#a': 'error',
      },
      ExpressionAttributeValues: {
        ':x': errs.getIndex('Invalid upload size'),
      },
    })

    return SUCCESS
  }

  // otherwise, the upload is successful, so we update the progress table
  await updateStatus(key, 'Successfully uploaded data')

  const s3Obj = await s3.getObject({
    Bucket: name,
    Key: key,
  }).promise()  
  console.log(s3Obj)

  // add code to process the object
  await updateStatus(key, 'Successfully processed data')

  await s3.putObject({
    Body: s3Obj.Body,
    Bucket: process.env.OUTPUT_BUCKET,
    Key: `modifiedobject_${key}`,
  }).promise()

  // here we dont actually enter anything into a database, but in a real application
  // you might make a table entry based on your application logic.
  await updateStatus(key, 'Successfully entered data into database')

  return SUCCESS
}