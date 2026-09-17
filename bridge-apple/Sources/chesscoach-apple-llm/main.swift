//
//  Apple Foundation Models bridge.
//
//  Speaks line-delimited JSON over stdio so the Node proxy can drive it:
//
//    stdin   {"system": "...", "prompt": "..."}\n
//    stdout  {"delta": "..."}\n   (repeated)
//            {"done": true}\n
//            {"error": "..."}\n
//
//  A `--status` invocation reports availability and exits, which is what the
//  settings panel's "Test connection" calls so it can explain *why* the
//  on-device model is unavailable rather than just failing.
//
import Foundation
import FoundationModels

struct Request: Decodable {
    let system: String
    let prompt: String
}

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

/// Why the model can't be used, in words a non-developer can act on.
func availability() -> (Bool, String) {
    switch SystemLanguageModel.default.availability {
    case .available:
        return (true, "On-device model ready.")
    case .unavailable(.deviceNotEligible):
        return (false, "This Mac does not support the on-device model.")
    case .unavailable(.appleIntelligenceNotEnabled):
        return (false, "Apple Intelligence is turned off in System Settings.")
    case .unavailable(.modelNotReady):
        return (false, "The on-device model is still downloading. Try again shortly.")
    case .unavailable(let other):
        return (false, "On-device model unavailable: \(other).")
    }
}

if CommandLine.arguments.contains("--status") {
    let (ok, detail) = availability()
    emit(["available": ok, "detail": detail])
    exit(0)
}

let (ready, reason) = availability()
guard ready else {
    emit(["error": reason])
    exit(1)
}

// One request per line, so the proxy can keep the process warm across moves.
while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty,
          let data = line.data(using: .utf8),
          let request = try? JSONDecoder().decode(Request.self, from: data) else {
        emit(["error": "Malformed request."])
        continue
    }

    do {
        let session = LanguageModelSession(instructions: request.system)
        var delivered = ""

        // streamResponse yields the full text so far, not just the new part;
        // the proxy expects incremental deltas, so diff against what we sent.
        for try await partial in session.streamResponse(to: request.prompt) {
            let text = partial.content
            guard text.count > delivered.count else { continue }
            let delta = String(text.dropFirst(delivered.count))
            delivered = text
            emit(["delta": delta])
        }

        emit(["done": true])
    } catch {
        emit(["error": "\(error)"])
    }
}
