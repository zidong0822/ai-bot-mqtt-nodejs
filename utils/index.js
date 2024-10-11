const qiniu = require("qiniu");
const { v4: uuidv4 } = require("uuid");
const CryptoJS = require("crypto-js");
const { toFile } = require("openai");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const ttsConfig = require("../config/tts.config.js");
const qiniuKey = {
  accessKey: "",
  secretKey: "",
};

function pcmBase64ToWav(pcmData, sampleRate, numChannels, bitsPerSample) {
  const wavHeader = createWavHeader(
    pcmData.length,
    sampleRate,
    numChannels,
    bitsPerSample
  );

  const wavBuffer = Buffer.concat([wavHeader, pcmData]);
  const base64Wav = wavBuffer.toString("base64");
  return { len: wavBuffer.length, speech: base64Wav };
}

function createWavHeader(dataLength, sampleRate, numChannels, bitsPerSample) {
  const buffer = Buffer.alloc(44);

  buffer.write("RIFF", 0); // ChunkID
  buffer.writeUInt32LE(36 + dataLength, 4); // ChunkSize
  buffer.write("WAVE", 8); // Format
  buffer.write("fmt ", 12); // Subchunk1ID
  buffer.writeUInt32LE(16, 16); // Subchunk1Size
  buffer.writeUInt16LE(1, 20); // AudioFormat
  buffer.writeUInt16LE(numChannels, 22); // NumChannels
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE((sampleRate * numChannels * bitsPerSample) / 8, 28); // ByteRate
  buffer.writeUInt16LE((numChannels * bitsPerSample) / 8, 32); // BlockAlign
  buffer.writeUInt16LE(bitsPerSample, 34); // BitsPerSample
  buffer.write("data", 36); // Subchunk2ID
  buffer.writeUInt32LE(dataLength, 40); // Subchunk2Size

  return buffer;
}

const calculateSign = (appKey, appSecret, q, salt, curtime) => {
  const strSrc = appKey + getInput(q) + salt + curtime + appSecret;
  return encrypt(strSrc);
};

const encrypt = (strSrc) => {
  return CryptoJS.SHA256(strSrc).toString(CryptoJS.enc.Hex);
};

const getInput = (input) => {
  if (input === null || input === undefined) {
    return input;
  }
  let inputLen = input.length;
  return inputLen <= 20
    ? input
    : input.substring(0, 10) + inputLen + input.substring(inputLen - 10);
};

const getAccessToken = async (AK, SK) => {
  const responese = await fetch(
    `${ttsConfig.baidu.domin}/oauth/2.0/token?grant_type=client_credentials&client_id=${AK}&client_secret=${SK}`,
    { method: "POST" }
  );
  const res = await responese.json();
  return res.access_token;
};

const uploadToQiniu = async (readableStream, fileName) => {
  return new Promise(async (resolve, reject) => {
    var mac = new qiniu.auth.digest.Mac(qiniuKey.accessKey, qiniuKey.secretKey);
    var options = {
      scope: `xiabanba:${fileName}`,
      expires: 3600000,
      fsizeLimit: 1024 * 1024 * 100,
    };
    var putPolicy = new qiniu.rs.PutPolicy(options);
    var uploadToken = putPolicy.uploadToken(mac);
    var config = new qiniu.conf.Config();
    config.zone = qiniu.zone.Zone_z1;
    var formUploader = new qiniu.form_up.FormUploader(config);
    var putExtra = new qiniu.form_up.PutExtra();
    formUploader.put(
      uploadToken,
      fileName,
      readableStream,
      putExtra,
      function (respErr, respBody, respInfo) {
        if (respErr) {
          reject(respErr);
        } else {
          resolve(respBody);
        }
      }
    );
  });
};

//有道语音识别接口
const recognizeSpeechWithYoudao = async (q, rate, channel) => {
  let salt = uuidv4();
  let curtime = Math.floor(new Date().getTime() / 1000);
  let sign = calculateSign(
    ttsConfig.youdao.appKey,
    ttsConfig.youdao.appSecret,
    q,
    salt,
    curtime
  );
  let signType = ttsConfig.youdao.signType;
  let domain = `${ttsConfig.youdao.domin}/asrapi`;
  let format = "wav";
  let type = 1;
  let langType = "zh-CHS";
  let responese = await fetch(domain, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      q,
      appKey: ttsConfig.youdao.appKey,
      salt,
      sign,
      signType,
      curtime,
      langType,
      format,
      rate,
      channel,
      type,
    }),
  });
  const res = await responese.json();
  if (res && res.errorCode === "0") {
    return res.result;
  }
  return [];
};

//百度语音识别
const recognizeSpeechWithBaidu = async (speech, rate, channel, len) => {
  const { AK, SK } = ttsConfig.baidu.speech;
  var options = {
    method: "POST",
    url: "https://vop.baidu.com/server_api",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      format: "wav",
      rate: rate,
      channel: channel,
      cuid: "3CPSpqXXrrvCnOGuYNhoRt0h0daaU7Hu",
      token: await getAccessToken(AK, SK),
      len: len,
      speech: speech,
    }),
  };

  const responese = await fetch("https://vop.baidu.com/server_api", options);
  const res = await responese.json();
  if (res && res["result"] && res["result"].length > 0) {
    return res["result"];
  }
  return null;
};

//openai语音识别接口
const recognizeSpeechWithOpenAI = async (openai, bufferStream) => {
  const transcription = await openai.audio.transcriptions.create({
    file: await toFile(bufferStream, "audio.wav", {
      contentType: "audio/wav",
    }),
    model: "whisper-1",
  });
  console.log("transcription", transcription);
  if (transcription && transcription.text) {
    return transcription.text;
  }
  return "";
};

//文心一言接口
const chatWithBaidu = async (message) => {
  const { AK, SK } = ttsConfig.baidu.text;
  let messagesToSend = [
    {
      role: "user",
      content: "请在回答问题时尽量保持意思简洁明了，长度不超过50字",
    },
  ];
  message = { role: "user", content: message };
  messagesToSend = messagesToSend.concat(message);
  const responese = await fetch(
    `${
      ttsConfig.baidu.domin
    }/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/eb-instant?access_token=${await getAccessToken(
      AK,
      SK
    )}`,
    {
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
      body: JSON.stringify({
        messages: [...messagesToSend],
        max_tokens: 1000,
        temperature: 0.1,
        stream: false,
      }),
    }
  );
  const res = await responese.json();
  if (res && res.result) {
    return res.result;
  }
  return "";
};

//GPT接口
const chatWithOpenAI = async (message) => {
  let messagesToSend = [];
  message = { role: "user", content: message };
  messagesToSend = [
    {
      role: "system",
      content: `你现在要扮演中国古典小说《西游记》中的孙悟空。请按照以下指引进行对话:
语气活泼幽默,充满自信。使用"俺老孙"来自称。
经常使用武术和神通相关的比喻,如"比俺的筋斗云还快"。
口头禅包括"好家伙"、"嘿嘿"等。
使用古代口语,如"俺"替代"我"、"这厮"替代"这家伙"、"晓得"替代"知道"等。
时常提到自己的武器如"金箍棒"和特殊能力如"七十二变"。
对佛道两教都有一定了解,但态度调皮顽劣。偶尔提到菩萨、如来或者天庭。
性格急躁,遇到不顺心的事会表现出些许暴躁。
对唐僧(师父)既尊敬又无奈,偶尔会抱怨取经路途的艰辛。
喜欢吹嘘自己的能力,但也会在关键时刻表现出忠诚和勇敢。
请以这种风格回答问题或进行对话,让对方感受到孙悟空独特的个性和魅力!`,
    },
    message,
    ...messagesToSend,
  ];
  console.log(messagesToSend);
  let domain = `${ttsConfig.openai.domin}/chat/completions`;
  const responese = await fetch(domain, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ttsConfig.openai.token}`,
    },
    method: "POST",
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [...messagesToSend],
      max_tokens: 1000,
      temperature: 0.1,
      stream: false,
    }),
  });
  const res = await responese.json();
  if (res && res["choices"] && res["choices"].length > 0) {
    return res["choices"][0]["message"]["content"];
  }
  return "";
};

//有道文字转语音接口
//https://ai.youdao.com/DOCSIRMA/html/tts/api/yyhc/index.html
const speechToAudioWithYoudao = async (q, voiceName = "youxiaoqin") => {
  let salt = uuidv4();
  let curtime = Math.floor(new Date().getTime() / 1000);
  let sign = calculateSign(
    ttsConfig.youdao.appKey,
    ttsConfig.youdao.appSecret,
    q,
    salt,
    curtime
  );
  let signType = ttsConfig.youdao.signType;
  let domain = `${ttsConfig.youdao.domin}/ttsapi`;
  let audioBuffer = null;
  let retries = 0;

  while (retries < 3) {
    let response = await fetch(domain, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        q,
        appKey: ttsConfig.youdao.appKey,
        salt,
        sign,
        signType,
        curtime,
        voiceName,
      }),
    });

    audioBuffer = await response.buffer();

    if (audioBuffer.length > 0) {
      break;
    }

    retries++;
  }

  if (audioBuffer.length === 0) {
    console.log("Failed to generate audio after 3 retries.");
    return null;
  }

  const data = await uploadToQiniu(audioBuffer, `${voiceName}-${curtime}.mp3`);
  return `https://image.bujuantools.com/${data.key}`;
};

//百度文字转语音接口
//https://console.bce.baidu.com/support/#/api?product=AI&project=%E8%AF%AD%E9%9F%B3%E6%8A%80%E6%9C%AF&parent=%E8%AF%AD%E9%9F%B3%E5%90%88%E6%88%90&api=rpc%2F2.0%2Ftts%2Fv1%2Fquery&method=post
const speechToAudioWithBaidu = async (q, voiceName) => {
  var options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      format: "mp3-16k",
      voice: 1,
      lang: "zh",
      text: [q],
    }),
  };

  var options1 = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };

  const { AK, SK } = ttsConfig.baidu.speech;
  const responese = await fetch(
    "https://aip.baidubce.com/rpc/2.0/tts/v1/create?access_token=" +
      (await getAccessToken(AK, SK)),
    options
  );
  const res = await responese.json();
  options1.body = JSON.stringify({
    task_ids: [res.task_id],
  });
  const result = await getSynthesisResultWithBaidu(options1, res.task_id);
  if (result.task_status === "Success") {
    const response1 = await fetch(result.task_result.speech_url);
    const audioBuffer = await response1.buffer();
    let curtime = Math.floor(new Date().getTime() / 1000);
    const data = await putImageData(audioBuffer, `baidu-${curtime}.mp3`);
    return `https://image.bujuantools.com/${data.key}`;
  }
  return "";
};

//openAI文字转语音接口
//https://platform.openai.com/docs/guides/text-to-speech/supported-languages
const speechToAudioWithOpenAI = async (
  speech,
  voice = "nova",
  model = "tts-1",
  aedes,
  openai
) => {
  try {
    const response = await openai.audio.speech.create({
      model: model,
      voice: voice,
      input: speech,
      speed: 0.25,
    });
    response.body.on("data", (chunk) => {
      aedes.publish({ topic: "receive_audio", payload: chunk });
    });
  } catch (error) {
    console.error("Error generating speech:", error);
  }
};

//FishAudio文本转语音
const speechToAudioWithFish = async (speech, aedes) => {
  const response = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer XXX`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: speech,
      reference_id: "cbc930548d6a4650a1304ba0c040a812",
      format: "mp3",
    }),
  });

  return new Promise((resolve, reject) => {
    let chunks = [];
    let totalLength = 0;

    response.body.on("data", (chunk) => {
      chunks.push(chunk);
      console.log("chunk", chunk);
      aedes.publish({ topic: "receive_audio", payload: chunk });
      totalLength += chunk.length;
    });

    response.body.on("end", async () => {
      try {
        const fileData = Buffer.concat(chunks, totalLength);
        let curtime = Math.floor(new Date().getTime() / 1000);
        const data = await uploadToQiniu(fileData, `baidu-${curtime}.mp3`);
        resolve(`https://image.bujuantools.com/${data.key}`);
      } catch (error) {
        reject(error);
      }
    });

    response.body.on("error", (err) => {
      reject(err);
    });
  });
};

const getSynthesisResultWithBaidu = async (options, taskId) => {
  let result = null;
  const { AK, SK } = ttsConfig.baidu.speech;
  while (true) {
    const responese = await fetch(
      "https://aip.baidubce.com/rpc/2.0/tts/v1/query?access_token=" +
        (await getAccessToken(AK, SK)),
      options
    );
    const res = await responese.json();
    const tasksInfo = res.tasks_info;
    const task = tasksInfo.find((task) => task.task_id === taskId);
    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    if (task.task_status === "Running") {
      // 继续查询任务状态
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } else {
      result = task;
      break;
    }
  }
  return result;
};

module.exports = {
  recognizeSpeechWithYoudao,
  recognizeSpeechWithBaidu,
  recognizeSpeechWithOpenAI,
  chatWithOpenAI,
  chatWithBaidu,
  speechToAudioWithBaidu,
  speechToAudioWithYoudao,
  speechToAudioWithOpenAI,
  speechToAudioWithFish,
};
