"use server";

import { NextResponse } from "next/server";
import path from "path";
import { createIndexIfNecessary, pineconeIndexHasVectors } from "./pinecone";
import { DirectoryLoader } from "langchain/document_loaders/fs/directory";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { promises as fs } from "fs";
import { type Document } from "../types/document";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { v4 as uuidv4 } from "uuid";
import { VoyageEmbeddings } from "@langchain/community/embeddings/voyage";
import { Pinecone } from "@pinecone-database/pinecone";

const readMetadata = async (): Promise<Document["metadata"][]> => {
  try {
    const filePath = path.resolve(process.cwd(), "docs/db.json");
    const data = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(data);
    return parsed.documents || [];
  } catch (e) {
    console.warn("Error reading metadata file from db.json", e);
    return [];
  }
};

const batchUpserts = async (
  index: any,
  vectors: any[],
  batchSize: number = 50
) => {
  for (let i = 0; i < vectors.length; i += batchSize) {
    const batch = vectors.slice(i, i + batchSize);
    console.log(
      `Upserting batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(
        vectors.length / batchSize
      )}`
    );
    await index.upsert(batch);
  }
};

const flattenMetadata = (metadata: any): Document["metadata"] => {
  const flatMetadata = { ...metadata };
  if (flatMetadata.pdf) {
    if (flatMetadata.pdf.pageCount) {
      flatMetadata.totalPages = flatMetadata.pdf.pageCount;
    }
    delete flatMetadata.pdf;
  }
  if (flatMetadata.loc) {
    delete flatMetadata.loc;
  }
  return flatMetadata;
};

export const initiateBootstrapping = async (targetIndex: string) => {
  const baseURL = process.env.PRODUCTION_URL
    ? `https://${process.env.PRODUCTION_URL}`
    : "http://localhost:3000";

  const response = await fetch(`${baseURL}/api/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ targetIndex }),
  });
  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}`);
  }
};

const isValidContent = (pageContent: string): boolean => {
  if (!pageContent || typeof pageContent !== "string") {
    return false;
  }
  const trimmed = pageContent.trim();
  return trimmed.length > 0 && trimmed.length < 8192;
};

export const handleBootstrapping = async (targetIndex: string) => {
  try {
    console.log(
      `Running bootstrapping procedure against Pinecone index ${targetIndex}`
    );

    await createIndexIfNecessary(targetIndex);
    const hasVectors = await pineconeIndexHasVectors(targetIndex);
    if (hasVectors) {
      console.log(
        `Index ${targetIndex} already has vectors, skipping bootstrapping and returning early to proceed with search`
      );
      return NextResponse.json({ success: true }, { status: 200 });
    }

    console.log("Loading document and metadata...");

    const docsPath = path.resolve(process.cwd(), "docs/");
    const loader = new DirectoryLoader(docsPath, {
      ".pdf": (filePath: string) => new PDFLoader(filePath),
    });

    const documents = await loader.load();

    if (documents.length === 0) {
      console.log("No PDF documents found in the docs directory");
      return NextResponse.json(
        { error: "No documents found in the docs directory" },
        { status: 400 }
      );
    }

    const metadata = await readMetadata();

    const validDocuments = documents.filter((doc) =>
      isValidContent(doc.pageContent)
    );

    validDocuments.forEach((doc) => {
      const fileMetadata = metadata.find(
        (meta) => meta.filename === path.basename(doc.metadata.source)
      );
      if (fileMetadata) {
        doc.metadata = {
          ...doc.metadata,
          ...fileMetadata,
          pageContent: doc.pageContent,
        };
      }
    });

    console.log(
      `Found ${documents.length} documents, ${validDocuments.length} of which are valid`
    );

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    const splits = await splitter.splitDocuments(validDocuments);
    console.log(
      `Split ${validDocuments.length} documents into ${splits.length} chunks`
    );

    const BATCH_SIZE = 5;

    for (let i = 0; i < splits.length; i += BATCH_SIZE) {
      const batch = splits.slice(i, i + BATCH_SIZE);
      console.log(
        `Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(
          splits.length / BATCH_SIZE
        )}`
      );

      const validBatch = batch.filter((split) =>
        isValidContent(split.pageContent)
      );
      if (validBatch.length === 0) {
        console.log("No valid content in this batch, skipping");
        continue;
      }

      const castedBatch: Document[] = validBatch.map((split) => ({
        pageContent: split.pageContent.trim(),
        metadata: {
          ...flattenMetadata(split.metadata as Document["metadata"]),
          id: uuidv4(),
          pageContent: split.pageContent.trim(),
        },
      }));

      // Initialize VoyageEmbeddings with batchSize and retryStrategy
      const voyageEmbeddings = new VoyageEmbeddings({
        apiKey: process.env.VOYAGE_API_KEY,
        inputType: "document",
        modelName: "voyage-law-2",
        batchSize: 5, // Added batchSize
      });

      try {
        const pageContents = castedBatch.map((split) => split.pageContent);
        console.log(
          `Generating embeddings for batch ${Math.floor(i / BATCH_SIZE) + 1}`
        );
        const embeddings = await voyageEmbeddings.embedDocuments(
          pageContents.map((content) => content.trim())
        );

        if (!embeddings || embeddings.length === 0) {
          console.error("No embeddings generated for batch");
          continue;
        }

        console.log(`Successfully generated ${embeddings.length} embeddings`);

        const vectors = castedBatch.map((split, index) => ({
          id: split.metadata.id,
          values: embeddings[index],
          metadata: split.metadata,
        }));

        if (!process.env.PINECONE_API_KEY) {
          throw new Error("PINECONE_API_KEY environment variable is not set");
        }
        const pc = new Pinecone({
          apiKey: process.env.PINECONE_API_KEY,
        });

        const index = pc.Index(targetIndex);
        await batchUpserts(index, vectors, 2);

        // Adding delay between batches to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(
          `Error in batch ${Math.floor(i / BATCH_SIZE) + 1}:`,
          error
        );
        // Add delay before proceeding to the next batch
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
    }

    console.log("Bootstrap procedure completed successfully.");
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: any) {
    console.error("Error during bootstrap procedure:", {
      message: error.message,
      cause: error.cause?.message,
      stack: error.stack,
    });

    if (error.code === "UND_ERR_CONNECT_TIMEOUT") {
      return NextResponse.json(
        { error: "Operation timed out - please try again" },
        { status: 504 }
      );
    }

    return NextResponse.json(
      { error: "Bootstrap procedure failed" },
      { status: 500 }
    );
  }
};

// Older bootstrap.ts:
// "use server";

// import { NextResponse } from "next/server";
// import path from "path";
// import { createIndexIfNecessary, pineconceIndexHasVectors } from "./pinecone";
// import { DirectoryLoader } from "langchain/document_loaders/fs/directory";
// import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
// import { promises as fs } from "fs";
// import { type Document } from "../types/document";
// import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
// import { v4 as uuidv4 } from "uuid";
// import { VoyageEmbeddings } from "@langchain/community/embeddings/voyage";
// import { Pinecone } from "@pinecone-database/pinecone";

// const readMetadata = async (): Promise<Document["metadata"][]> => {
//   try {
//     const filePath = path.resolve(process.cwd(), "docs/db.json");
//     const data = await fs.readFile(filePath, "utf-8");
//     const parsed = JSON.parse(data);
//     return parsed.documents || [];
//   } catch (e) {
//     console.warn("Error reading metadata file from db.json", e);
//     return [];
//   }
// };

// const batchUpserts = async (
//   index: any,
//   vectors: any[],
//   batchSize: number = 50
// ) => {
//   for (let i = 0; i < vectors.length; i += batchSize) {
//     const batch = vectors.slice(i, i + batchSize);
//     console.log(
//       `Upserting batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(
//         vectors.length / batchSize
//       )}`
//     );
//     await index.upsert(batch);
//   }
// };

// const flattenMetadata = (metadata: any): Document["metadata"] => {
//   const flatMetadata = { ...metadata };
//   if (flatMetadata.pdf) {
//     if (flatMetadata.pdf.pageCount) {
//       flatMetadata.totalPages = flatMetadata.pdf.pageCount;
//     }
//     delete flatMetadata.pdf;
//   }
//   if (flatMetadata.loc) {
//     delete flatMetadata.loc;
//   }
//   return flatMetadata;
// };

// // The function will initiate the bootstrapping process by making a POST request to the /api/ingest endpoint. The targetIndex will be passed as a parameter to the API, so the API knows which index to bootstrap the data into.

// export const initiateBootstrapping = async (targetIndex: string) => {
//     // the baseURL is going to tell the application where to locate the APIs; be it in local host or in production, the app should be able to bootstrap the data without any problem.

//   const baseURL = process.env.PRODUCTION_URL
//     ? `https://${process.env.PRODUCTION_URL}`
//     : "http://localhost:3000";

//   const response = await fetch(`${baseURL}/api/ingest`, {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//     },
//     body: JSON.stringify({ targetIndex }),
//   });
//   if (!response.ok) {
//     throw new Error(`API request failed with status ${response.status}`);
//   }
// };

// // The function will check if the document is valid by checking if the page content is not empty and if the page content is not just a whitespace.

// const isValidContent = (pageContent: string): boolean => {
//   if (!pageContent || typeof pageContent !== "string") {
//     return false;
//   }
//   const trimmed = pageContent.trim();
//   return trimmed.length > 0 && trimmed.length < 8192;
// };

// export const handleBootstrapping = async (targetIndex: string) => {
//   try {
//     console.log(
//       `Running bootstrapping procedure against Pinecone index ${targetIndex}`
//     );

//     await createIndexIfNecessary(targetIndex);
//     const hasVectors = await pineconceIndexHasVectors(targetIndex);
//     if (hasVectors) {
//       console.log(
//         `Index ${targetIndex} already has vectors, skipping bootstrapping and returning early to proceed with search`
//       );
//       return NextResponse.json({ success: true }, { status: 200 });
//     }

//     // If we don't have vectors, we need to bootstrap the data, i.e. load the document and their metadata, then prepare them, ingest them, i.e. data into the Pinecone index, creating an index for them to be searchable.

//     console.log("Loading document and metadata...");

//     const docsPath = path.resolve(process.cwd(), "docs/");
//     const loader = new DirectoryLoader(docsPath, {
//       ".pdf": (filePath: string) => new PDFLoader(filePath),
//     });

//     const documents = await loader.load();

//     if (documents.length === 0) {
//       console.log("No PDF documents found in the docs directory");
//       return NextResponse.json(
//         { error: "No documents found in the docs directory" },
//         { status: 400 }
//       );
//     }

//     const metadata = await readMetadata();

//     const validDocuments = documents.filter((doc) =>
//       isValidContent(doc.pageContent)
//     );

//     validDocuments.forEach((doc) => {
//       const fileMetadata = metadata.find(
//         (meta) => meta.filename === path.basename(doc.metadata.source)
//       );
//       if (fileMetadata) {
//         doc.metadata = {
//           ...doc.metadata,
//           ...fileMetadata,
//           pageContent: doc.pageContent,
//         };
//       }
//     });

//     console.log(
//       `Found ${documents.length} documents, ${validDocuments.length} of which are valid`
//     );

//     // We now split the document into smaller chunks for the AI to be able to index them correctly/convert them into vector embeddings correctly.

//     const splitter = new RecursiveCharacterTextSplitter({
//       chunkSize: 1000,
//       chunkOverlap: 200,
//     });
//     const splits = await splitter.splitDocuments(validDocuments);
//     console.log(
//       `Split ${validDocuments.length} documents into ${splits.length} chunks`
//     );

//     const BATCH_SIZE = 5;

//     for (let i = 0; i < splits.length; i += BATCH_SIZE) {
//       const batch = splits.slice(i, i + BATCH_SIZE);
//       console.log(
//         `Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(
//           splits.length / BATCH_SIZE
//         )}`
//       );

//       const validBatch = batch.filter((split) =>
//         isValidContent(split.pageContent)
//       );
//       if (validBatch.length === 0) {
//         console.log("No valid content in this batch, skipping");
//         continue;
//       }

//       const castedBatch: Document[] = validBatch.map((split) => ({
//         pageContent: split.pageContent.trim(),
//         metadata: {
//           ...flattenMetadata(split.metadata as Document["metadata"]),
//           id: uuidv4(),
//           pageContent: split.pageContent.trim(),
//         },
//       }));

//       try {
//         const voyageEmbeddings = new VoyageEmbeddings({
//           apiKey: process.env.VOYAGE_API_KEY,
//           inputType: "document",
//           modelName: "voyage-law-2",
//         });

//         const pageContents = castedBatch.map((split) => split.pageContent);
//         console.log(
//           `Generating embeddings for ${pageContents.length} chunks/page contents`
//         );
//         const embeddings = await voyageEmbeddings.embedDocuments(pageContents);

//         if (!embeddings || embeddings.length !== pageContents.length) {
//           console.log("Error generating embeddings, skipping this batch", {
//             expected: pageContents.length,
//             received: embeddings ? embeddings.length : 0,
//           });
//           continue;
//         }

//         const vectors = castedBatch.map((split, index) => ({
//           id: split.metadata.id,
//           values: embeddings[index],
//           metadata: split.metadata,
//         }));

//         if (!process.env.PINECONE_API_KEY) {
//           throw new Error("PINECONE_API_KEY environment variable is not set");
//         }
//         const pc = new Pinecone({
//           apiKey: process.env.PINECONE_API_KEY,
//         });

//         const index = pc.Index(targetIndex);
//         await batchUpserts(index, vectors, 2);

//         // Adding delay between batches to avoid rate limiting
//         await new Promise((resolve) => setTimeout(resolve, 1000));
//       } catch (error) {
//         console.error(
//           `Error generating embeddings for batch ${
//             Math.floor(i / BATCH_SIZE) + 1
//           }:`,
//           {
//             error: error instanceof Error ? error.message : "Unknown error",
//             batchSize: castedBatch.length,
//           }
//         );
//         continue;
//       }
//     }

//     console.log("Bootstrap procedure completed successfully.");
//     return NextResponse.json({ success: true }, { status: 200 });
//   } catch (error: any) {
//     console.error("Error during bootstrap procedure:", {
//       message: error.message,
//       cause: error.cause?.message,
//       stack: error.stack,
//     });

//     if (error.code === "UND_ERR_CONNECT_TIMEOUT") {
//       return NextResponse.json(
//         { error: "Operation timed out - please try again" },
//         { status: 504 }
//       );
//     }

//     return NextResponse.json(
//       { error: "Bootstrap procedure failed" },
//       { status: 500 }
//     );
//   }
// };