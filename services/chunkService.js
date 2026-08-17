const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");

const { config } = require("../config/env");

// The splitter is stateless across calls, so one instance is reused rather than
// constructed per indexing run.
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: config.chunking.chunkSize,
  chunkOverlap: config.chunking.chunkOverlap,
});

/**
 * Splits raw text into overlapping documents.
 *
 * Returns LangChain `Document` objects — read `.pageContent`, not the object.
 */
async function chunkText(text) {
  return await splitter.createDocuments([text]);
}

module.exports = { chunkText };
