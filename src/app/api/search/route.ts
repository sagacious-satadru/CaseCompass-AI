import { NextResponse } from "next/server";
import { Pinecone } from "@pinecone-database/pinecone";
import { VoyageEmbeddings } from "@langchain/community/embeddings/voyage";
import { PineconeStore } from "@langchain/pinecone";

export async function POST(req: Request) {
  const { query } = await req.json();

  if (!query) {
    return NextResponse.json({ error: "Query is required" }, { status: 400 });
  }

  try {
    if (!process.env.PINECONE_API_KEY) {
      throw new Error("PINECONE_API_KEY is not defined");
    }

    if (!process.env.PINECONE_INDEX) {
      throw new Error("PINECONE_INDEX is not defined");
    }

    if (!process.env.VOYAGE_API_KEY) {
      throw new Error("VOYAGE_API_KEY is not defined");
    }
    
    // Initialize Pinecone client
    const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

    // Initialize VoyageEmbeddings
    const voyageEmbeddings = new VoyageEmbeddings({
      apiKey: process.env.VOYAGE_API_KEY,
      inputType: "query",
      modelName: "voyage-law-2",
    });

    // Initialize PineconeStore
    const vectorStore = new PineconeStore(voyageEmbeddings, {
      pineconeIndex: pc.Index(process.env.PINECONE_INDEX),
    });

    console.log(`Searching for query: ${query}`);

    // Perform Max Marginal Relevance Search
    const retrieved = await vectorStore.maxMarginalRelevanceSearch(query, {
      k: 20,
      fetchK: 100,
      lambda: 0.5,
    });

    // Deduplicate results based on title
    const uniqueResults = Array.from(
      new Map(
        retrieved.map(item => [item.metadata.title, item])
      ).values()
    );

    return NextResponse.json({ results: uniqueResults }, { status: 200 });
  } catch (error) {
    console.error(`Error searching for query:`, error);
    return NextResponse.json(
      { error: "Error searching for query" },
      { status: 500 }
    );
  }
}

// Older route.ts that doesn't handle duplicates in the search results

// import { NextResponse } from "next/server";
// import { Pinecone } from "@pinecone-database/pinecone";
// import { VoyageEmbeddings } from "@langchain/community/embeddings/voyage";
// import { PineconeStore } from "@langchain/pinecone";
// import { error } from "console";

// export async function POST(req: Request) {
//   const { query } = await req.json();

//   // if the query does not exist, then we throrw an error
//   if (!query) {
//     return NextResponse.json({ error: "Query is required" }, { status: 400 });
//   }

//   try {
//     // const pc = new Pinecone({apiKey: process.env.PINECONE_API_KEY!}); // creates a new instance of the Pinecone client using the API key from your environment variables. The process.env.PINECONE_API_KEY accesses the PINECONE_API_KEY environment variable, and the exclamation mark ! is the non-null assertion operator in TypeScript, indicating to the compiler that this value is not null or undefined.

//     /* By initializing pc with your API key, we're authenticating with the Pinecone service, allowing us to perform operations such as creating indexes, inserting vectors, and querying data. */
//     /* We have to be cautious with the non-null assertion operator. If PINECONE_API_KEY is not set, it could lead to a runtime error. To ensure the API key is provided, we might add a check as shown in the approach below */
//     if (!process.env.PINECONE_API_KEY) {
//       throw new Error(
//         "PINECONE_API_KEY is not defined in the environment variables."
//       ); /* If the PINECONE_API_KEY environment variable is not set, we throw an error. This way, the code will alert us if the API key is missing, preventing potential issues when the application runs. */
//     }
//     const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

//     // Initialize VoyageEmbeddings with correct inputType for queries
//     const voyageEmbeddings = new VoyageEmbeddings({
//       apiKey: process.env.VOYAGE_API_KEY,
//       inputType: "query",
//       modelName: "voyage-law-2",
//     });

//     // Initialize the Pinecone vector store
//     const vectorStore = new PineconeStore(voyageEmbeddings, {
//       pineconeIndex: pc.Index(process.env.PINECONE_INDEX as string),
//     });

//     console.log(`Searching for query: ${query}`);

//     const retrieved = await vectorStore.maxMarginalRelevanceSearch(query, {
//       k: 20,
//     });

//     const results: any = retrieved.filter((result, index) => {
//         return (
//             index === retrieved.findIndex((otherResult: any) => {
//                 return otherResult.metadata.id === result.metadata.id;
//             })
//         );
//     });

//     return NextResponse.json({ results }, { status: 200 });
//   } catch (error) {
//     console.error(`Error searching for query: ${error}`);
//     return NextResponse.json({ error: "Error searching for query" }, { status: 500 });
//   }
// }
