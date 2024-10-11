const aedes = require("aedes")();
const server = require("net").createServer(aedes.handle);
const OpenAI = require("openai");
const fs = require("fs");
const {
  recognizeSpeechWithOpenAI,
  chatWithOpenAI,
  chatWithBaidu,
  speechToAudioWithOpenAI,
  speechToAudioWithBaidu,
  speechToAudioWithYoudao,
  speechToAudioWithFish,
} = require("./utils");
const port = 1883;
const openai = new OpenAI({
  apiKey: "sk-XXX",
});
let receivedPackets = {};
// 监听客户端连接
aedes.on("client", function (client) {
  console.log("新连接: ", client.id);
});

// 监听客户端发布（publish）事件
aedes.on("publish", async (packet, client) => {
  if (client) {
    if (packet.topic === "send_conversation") {
      let result = JSON.parse(packet.payload.toString());
      aedes.publish({
        topic: "receive_status",
        payload: `${result.packetId || ""}`,
      });
      if (result.data === "start") {
        receivedPackets = {};
      }
      if (result.data !== "start" && result.data !== "end") {
        receivedPackets[result.packetId] = Buffer.from(result.data, "base64");
        console.log("receivedPackets", result.packetId);
      }
      if (result.data === "end") {
        let fullFile = Buffer.concat(Object.values(receivedPackets));
        console.log("fullFile type:", typeof fullFile);
        console.log("fullFile instanceof Buffer:", fullFile instanceof Buffer);
        console.log("fullFile length:", fullFile.length);
        let speechResult = await recognizeSpeechWithOpenAI(openai, fullFile);
        if (speechResult) {
          aedes.publish({
            topic: "recognize_result",
            payload: speechResult,
          });
          let chatRes = await chatWithOpenAI(speechResult);
          aedes.publish({ topic: "receive_text", payload: chatRes });
          // let url = await speechToAudioWithOpenAI(
          //   chatRes,
          //   "nova",
          //   "tts-1",
          //   aedes
          // );
          let url = await speechToAudioWithFish(chatRes, aedes);
          console.log(url);
          aedes.publish({ topic: "receive_conversation", payload: url });
        }
        receivedPackets = {};
      }
    }
  }
});

// 监听客户端订阅（subscribe）事件
aedes.on("subscribe", function (subscriptions, client) {
  if (client) {
    console.log(client.id, "订阅", subscriptions.map((s) => s.topic).join(","));
  }
});

// 监听客户端断开连接事件
aedes.on("clientDisconnect", function (client) {
  console.log("连接断开:", client ? client.id : "unknown");
});

// 监听客户端取消订阅事件
aedes.on("unsubscribe", function (subscriptions, client) {
  if (client) {
    console.log(client.id, "取消订阅", subscriptions.join(","));
  }
});

aedes.on("error", (error) => {
  console.log("错误", error);
});

server.listen(port, function () {
  console.log("MQTT服务开始监听端口", port);
});

const test = async (tempInputPath) => {
  const aaa = await chatWithOpenAI("你好啊");
  console.log(aaa);
  // const buffer = await fs.readFileSync(
  //   "./fd324da01dca4fc9a04579f1f63e06e0.mp3"
  // );
  // const aa = buffer.toString("base64");
  // const bb = Buffer.from(aa, "base64");
  // let speechResult = await recognizeSpeechWithOpenAI(openai, bb);
  // let chatRes = await chatWithBaidu("请介绍一下上海浦东");
  // console.log(chatRes);
  // let url = await speechToAudioWithYoudao(chatRes, "youxiaoqin");
  // let url = await speechToAudioWithOpenAI(
  //   chatRes,
  //   "nova",
  //   "tts-1",
  //   aedes,
  //   openai
  // );

  // let url = await speechToAudioWithFish(chatRes, aedes);
  // console.log("url", url);
};
// test("./fd324da01dca4fc9a04579f1f63e06e0.mp3").then((bb) => {});
