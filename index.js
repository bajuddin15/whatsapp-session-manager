require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fsExtra = require("fs-extra");
const http = require("http");
const qrcode = require("qrcode");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { Server: WebSocketServer } = require("ws");
const connectDB = require("./db/connectDB");
const User = require("./models/user");

// import all routes
const apiRoute = require("./routes/api");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(cors());
app.use(express.static("public")); // Serve static files from 'public' directory

const sessions = {};
let wsClients = {};
const clients = {}; // Global object to store clients

wss.on("connection", function connection(ws) {
  ws.on("message", function incoming(message) {
    console.log("received: %s", message);
    const { devToken, action } = JSON.parse(message);
    if (devToken) {
      if (action === "logout") {
        // Handle logout request
        handleLogout(devToken, ws);
      } else if (sessions[devToken] && sessions[devToken].isReady) {
        // If session is already established, notify the frontend to hide the loader
        ws.send(JSON.stringify({ type: "session_already_ready" }));
      } else if (!sessions[devToken]) {
        startWhatsAppSession(devToken, ws);
      }
    }
  });
});

const DELAY_BEFORE_REMOVAL = 500; // Adjust the delay as needed
const MAX_RETRIES = 10; // Maximum number of retries

async function waitForReleaseAndRemove(sessionPath, retries = 0) {
  try {
    await fsExtra.remove(sessionPath);
    console.log(`Session files deleted successfully`);
  } catch (err) {
    if (err.code === "EBUSY" && retries < MAX_RETRIES) {
      console.log(
        `Retrying removal (attempt ${retries + 1}/${MAX_RETRIES})...`
      );
      setTimeout(() => {
        waitForReleaseAndRemove(sessionPath, retries + 1);
      }, DELAY_BEFORE_REMOVAL);
    } else {
      console.error(`Error removing session files: ${err}`);
    }
  }
}

// Add the handleLogout function
async function handleLogout(devToken, ws) {
  if (sessions[devToken]) {
    // Logout and terminate the WhatsApp session
    sessions[devToken].destroy();
    delete sessions[devToken];

    // Clean up session files using fs-extra
    const sessionPath = `./whatsapp-sessions/session-${devToken}`;
    waitForReleaseAndRemove(sessionPath);
    await User.findOneAndDelete({ devToken: devToken });
    // Notify the frontend that the session has been terminated
    if (wsClients[devToken]) {
      wsClients[devToken].send(JSON.stringify({ type: "logout" }));
      delete wsClients[devToken];
      ws.send(JSON.stringify({ type: "logout" }));
    }
  }
}

// ... [previous code remains unchanged]
function startWhatsAppSession(devToken, ws) {
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: `${devToken}`,
      dataPath: "./whatsapp-sessions",
    }),
  });

  client.on("qr", async (qr) => {
    qrcode.toDataURL(qr, (err, url) => {
      ws.send(JSON.stringify({ type: "qr", data: url }));
    });
  });

  client.on("ready", async () => {
    sessions[devToken] = client;
    wsClients[devToken] = ws;
    ws.send(JSON.stringify({ type: "session_ready" }));
    sessions[devToken].isReady = true; // Set the session ready flag
    const clientInfo = client.info;

    const userData = {
      name: clientInfo.pushname,
      phone: clientInfo.wid.user,
      widServer: clientInfo.wid.server,
      devToken: devToken,
    };
    try {
      const url =
        "https://app.crm-messaging.cloud/index.php/Api/addWhatsAppProvider";
      const headers = {
        "Content-Type": "application/x-www-form-urlencoded",
      };
      const formData = `token=${encodeURIComponent(
        devToken
      )}&phoneNumber=${encodeURIComponent(clientInfo.wid.user)}`;

      const { data } = await axios.post(url, formData, { headers });
    } catch (error) {}
    const isUserExist = await User.findOne({ devToken: devToken });
    if (!isUserExist) {
      const user = await User(userData);
      await user.save();
    }
  });

  client.on("message", async (message) => {
    // Send incoming message to frontend
    ws.send(JSON.stringify({ type: "incoming_message", data: message.body }));
    let mediaUrl = "";
    if (message?.hasMedia) {
      const media = await message.downloadMedia();

      if (media && media?.mimetype && media?.data) {
        const { mimetype, data } = media;
        const headers = {
          "Content-Type": "multipart/form-data",
        };
        const file = `data:${mimetype};base64,${data}`;

        const formData = new FormData();
        formData.append("userfile", file);

        const response = await axios.post(
          "https://app.crm-messaging.cloud/index.php/api/upload_file",
          formData,
          {
            headers: headers,
          }
        );
        if (response && response.status === 200) {
          mediaUrl = response.data?.url;
        }
      }
    }

    const url =
      "https://app.crm-messaging.cloud/index.php/Message/getMessageWhatsApp";
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    const extractedData = {
      id: message._data?.id.id,
      to: message._data?.to.split("@")[0],
      from: message._data?.from.split("@")[0],
      body: message._data?.body,
      type: message._data?.type,
      caption: message._data?.caption || "",
      timestamp: message.timestamp,
      hasMedia: message.hasMedia,
      notifyName: message._data?.notifyName,
    };
    const msgBody =
      extractedData?.type === "chat"
        ? extractedData?.body
        : extractedData?.caption;

    const formData = new FormData();
    formData.append("msgId", extractedData.id);
    formData.append("from", extractedData.from);
    formData.append("to", extractedData.to);
    formData.append("msg", msgBody);
    formData.append("mediaUrl", mediaUrl);

    console.log("extracted data------------------", formData);

    try {
      const { data } = await axios.post(url, formData, {
        headers,
      });
      console.log("API Response and send to CRM Messaging:", data);
    } catch (error) {
      console.error("Error in CRM:", error.message);
    }
    if (message.body.toLowerCase() === "ping") {
      const replyText = "pong";
      await message.reply(replyText);
      ws.send(JSON.stringify({ type: "outgoing_message", data: replyText }));
    }
  });

  client.initialize();
}

// ... [rest of the backend code]
// api
app.post("/api/sendMessage", async (req, res) => {
  const { devToken, to, msg, mediaUrl } = req.body;

  try {
    if (!sessions[devToken] || !sessions[devToken].isReady) {
      return res.status(400).json({ error: "WhatsApp session not ready" });
    }

    const client = sessions[devToken];

    // Ensure the recipient number is provided in the correct format
    // const recipient = `+919368054821`;
    const recipient = `${to}@c.us`;

    // Send text message
    await client.sendMessage(recipient, msg);

    // Check if mediaUrl is provided and send media if so
    if (mediaUrl) {
      try {
        const media = await MessageMedia.fromUrl(mediaUrl);
        await client.sendMessage(recipient, media);
      } catch (error) {
        console.log("Error in sending media : ", error.message);
      }
    }

    return res.json({ success: true, message: "Message send successfully" });
  } catch (error) {
    console.error("Error sending message:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.use("/api", apiRoute);

const PORT = process.env.PORT || 4000;
connectDB()
  .then(
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    })
  )
  .catch((err) => console.log(err));
