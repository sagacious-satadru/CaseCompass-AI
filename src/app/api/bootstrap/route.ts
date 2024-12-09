import { initiateBootstrapping } from "@/app/services/bootstrap";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
    // Initiate bootstrapping    
    await initiateBootstrapping(process.env.PINECONE_INDEX as string);
    // then return next response
    return NextResponse.json({"success": true}, {status: 200});
};