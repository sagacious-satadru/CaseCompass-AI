import { handleBootstrapping } from "@/app/services/bootstrap";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
    const { targetIndex } = await req.json();
    // handle the bootstrapping
    await handleBootstrapping(targetIndex);
    // then return NextResponse
    return NextResponse.json({ success: true }, { status: 200 });
    
}