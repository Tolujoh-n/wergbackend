const mongoose = require("mongoose");

const EthPriceSchema = new mongoose.Schema({
  usd: {
    type: Number,
    required: true,
  },
  lastUpdated: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("EthPrice", EthPriceSchema);
