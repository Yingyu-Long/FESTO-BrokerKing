import { handleUnifiedApiRequest } from "@/server/unifiedBackend.js";

export async function GET(request: Request) {
  return handleUnifiedApiRequest(request);
}

export async function POST(request: Request) {
  return handleUnifiedApiRequest(request);
}

export async function PUT(request: Request) {
  return handleUnifiedApiRequest(request);
}

export async function DELETE(request: Request) {
  return handleUnifiedApiRequest(request);
}
