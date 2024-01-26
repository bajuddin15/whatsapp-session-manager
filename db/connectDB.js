const mongoose = require("mongoose");

const connectDB = async () => {
  await mongoose
    .connect(process.env.MONGODB_URI)
    .then((conn) => {
      console.log(`MongoDB connected with host : ${conn.connection.host}`);
    })
    .catch((err) => {
      console.log(`MongoDB connection Error: `, err);
      process.exit(1);
    });
};

module.exports = connectDB;
