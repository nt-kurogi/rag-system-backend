export function toRemoteFileInput(fileUrl) {
  const url = String(fileUrl || "").trim();
  if (!url) return null;
  return {
    type: "input_file",
    file_url: url,
  };
}
