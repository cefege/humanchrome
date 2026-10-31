//! Native Messaging frame encoding and recoverable incremental decoding.

use std::fmt;

use bytes::{Buf, Bytes, BytesMut};
use humanchrome_core::json_document::JsonDocument;
use thiserror::Error;
use tokio::io::{AsyncWrite, AsyncWriteExt};

/// Native Messaging's four-byte little-endian header length cap.
pub const MAX_FRAME_BYTES: u32 = 16 * 1024 * 1024;
/// Number of complete frames the host actor may process before yielding.
pub const MAX_FRAMES_PER_TICK: usize = 100;
const HEADER_BYTES: usize = 4;

/// A successfully decoded Native Messaging frame.
#[derive(Debug, Clone, PartialEq)]
pub struct InboundFrame {
    /// Lossless JSON document decoded from the frame body.
    pub value: JsonDocument,
    /// Number of bytes in the JSON frame body.
    pub body_len: usize,
}

/// A recoverable event produced while decoding Native Messaging input.
#[derive(Debug, Clone, PartialEq)]
pub enum CodecEvent {
    /// A complete JSON frame.
    Frame(InboundFrame),
    /// A malformed header or JSON body which does not close the source.
    ProtocolError { message: String },
}

/// Serialization failure while constructing an outbound Native Messaging frame.
#[derive(Debug, Error)]
pub enum EncodeError {
    /// JSON serialization failed before a frame could be constructed.
    #[error("failed to serialize native message: {0}")]
    Serialize(#[from] serde_json::Error),
    /// The JSON body cannot be represented in Native Messaging's u32 header.
    #[error("native message is too large: {length} bytes")]
    TooLarge {
        /// Serialized JSON body length.
        length: usize,
    },
    /// Writing a complete protocol frame failed.
    #[error("failed to write native message: {0}")]
    Write(#[from] std::io::Error),
}

/// Incremental Native Messaging decoder with a reusable receive buffer.
///
/// The caller owns source lifecycle and calls [`Self::next_event`] until it returns
/// `None`. Invalid lengths intentionally discard the entire buffered tail, matching
/// the existing host's resynchronization behavior.
#[derive(Debug, Default)]
pub struct NativeCodec {
    buffer: BytesMut,
    expected_len: Option<usize>,
}

impl NativeCodec {
    /// Creates an empty incremental decoder.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends bytes read from the active Native Messaging source.
    pub fn push_bytes(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    /// Returns the next complete frame or recoverable protocol error.
    #[must_use]
    pub fn next_event(&mut self) -> Option<CodecEvent> {
        if self.expected_len.is_none() {
            if self.buffer.len() < HEADER_BYTES {
                return None;
            }

            let length = u32::from_le_bytes(
                self.buffer[..HEADER_BYTES]
                    .try_into()
                    .expect("header availability was checked before converting its four bytes"),
            );
            self.buffer.advance(HEADER_BYTES);

            if length == 0 || length > MAX_FRAME_BYTES {
                // The TypeScript host drops everything buffered after an invalid header.
                self.buffer.clear();
                return Some(CodecEvent::ProtocolError {
                    message: format!("Invalid message length: {length}"),
                });
            }
            self.expected_len = Some(length as usize);
        }

        let expected_len = self
            .expected_len
            .expect("expected length is set after a complete valid header");
        if self.buffer.len() < expected_len {
            return None;
        }

        let body = self.buffer.split_to(expected_len).freeze();
        self.expected_len = None;
        let source = String::from_utf8_lossy(&body);
        match JsonDocument::parse(&source) {
            Ok(value) => Some(CodecEvent::Frame(InboundFrame {
                value,
                body_len: expected_len,
            })),
            Err(error) => Some(CodecEvent::ProtocolError {
                message: format!(
                    "Failed to parse message: {}",
                    v8_json_error_message(&source, &error)
                ),
            }),
        }
    }

    /// Drops buffered data after an actor swaps to a different source.
    pub fn clear(&mut self) {
        self.buffer.clear();
        self.expected_len = None;
    }

    /// Returns whether unread source bytes remain buffered.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty() && self.expected_len.is_none()
    }
}

/// Serializes a JSON value into one complete little-endian Native Messaging frame.
///
/// # Errors
///
/// Returns an error when JSON serialization fails or cannot fit the protocol header.
pub fn encode_frame(message: impl Into<JsonDocument>) -> Result<Bytes, EncodeError> {
    let mut frame = Vec::with_capacity(512);
    encode_frame_into(&message.into(), &mut frame)?;
    Ok(Bytes::from(frame))
}

/// Encode into a reusable buffer, reserving the header without copying the JSON body.
///
/// # Errors
/// Returns serialization or Native Messaging header-size errors.
pub fn encode_frame_into(message: &JsonDocument, buffer: &mut Vec<u8>) -> Result<(), EncodeError> {
    buffer.clear();
    buffer.resize(HEADER_BYTES, 0);
    message.write(&mut *buffer)?;
    let body_len = buffer.len() - HEADER_BYTES;
    let length = u32::try_from(body_len).map_err(|_| EncodeError::TooLarge { length: body_len })?;
    buffer[..HEADER_BYTES].copy_from_slice(&length.to_le_bytes());
    Ok(())
}

/// Writes one complete framed JSON message without producing non-protocol stdout output.
///
/// # Errors
///
/// Returns an error if serialization or the underlying writer fails.
pub async fn write_frame<W>(writer: &mut W, message: &JsonDocument) -> Result<(), EncodeError>
where
    W: AsyncWrite + Unpin,
{
    let mut frame = Vec::with_capacity(512);
    encode_frame_into(message, &mut frame)?;
    writer.write_all(&frame).await?;
    writer.flush().await?;
    Ok(())
}

fn v8_json_error_message(source: &str, error: &serde_json::Error) -> String {
    if source.trim().is_empty() {
        return "Unexpected end of JSON input".to_owned();
    }

    let is_eof = error.is_eof();
    let byte_position = if is_eof {
        source.len()
    } else {
        byte_position_for_error(source, error)
    };
    let position = source[..byte_position].encode_utf16().count();
    let (line, column) = utf16_line_and_column(source, byte_position);
    let at_position = |description: &str| {
        format!("{description} at position {position} (line {line} column {column})")
    };
    let preceding = source[..byte_position].trim_end();
    let offending = source[byte_position..].chars().next();

    if preceding.ends_with('{') || preceding.ends_with(",{") {
        return at_position("Expected property name or '}' in JSON");
    }
    if preceding.ends_with(',') {
        if object_expects_key(preceding) {
            return at_position("Expected double-quoted property name in JSON");
        }
        if is_eof && source[..byte_position].contains('[') {
            return "Unexpected end of JSON input".to_owned();
        }
    }
    if object_expects_colon(preceding) {
        return at_position("Expected ':' after property name in JSON");
    }
    if object_expects_separator(preceding) {
        let closer = if open_container_is_object(preceding) {
            "'}'"
        } else {
            "']'"
        };
        return at_position(&format!(
            "Expected ',' or {closer} after {} value in JSON",
            if closer == "'}'" {
                "property"
            } else {
                "array element"
            }
        ));
    }
    if source[..byte_position].ends_with('.') {
        return at_position("Unterminated fractional number in JSON");
    }
    if looks_like_leading_zero_number(source, byte_position) {
        return at_position("Unexpected number in JSON");
    }
    if let Some(description) = v8_string_error(source, byte_position, is_eof) {
        return at_position(description);
    }
    if is_eof && source == "-" {
        return at_position("No number after minus sign in JSON");
    }
    if is_eof && missing_exponent_number(source) {
        return at_position("Exponent part is missing a number in JSON");
    }
    if unterminated_string(&source[..byte_position]) {
        return at_position("Unterminated string in JSON");
    }
    if is_eof {
        return "Unexpected end of JSON input".to_owned();
    }
    if let Some(token) = offending
        && matches!(token, '}' | ']')
    {
        return format!("Unexpected token '{token}', \"{source}\" is not valid JSON");
    }
    if trailing_non_whitespace_after_value(source, byte_position) {
        return at_position("Unexpected non-whitespace character after JSON");
    }
    if let Some(token) = offending {
        return format!("Unexpected token '{token}', \"{source}\" is not valid JSON");
    }
    "Unexpected end of JSON input".to_owned()
}

fn byte_position_for_error(source: &str, error: &serde_json::Error) -> usize {
    let target_line = error.line().saturating_sub(1);
    let target_column = error.column().saturating_sub(1);
    let mut line = 0;
    let mut column = 0;
    for (index, character) in source.char_indices() {
        if line == target_line && column >= target_column {
            return index;
        }
        if character == '\n' {
            line += 1;
            column = 0;
        } else {
            column += 1;
        }
    }
    source.len()
}

fn utf16_line_and_column(source: &str, byte_position: usize) -> (usize, usize) {
    let prefix = &source[..byte_position];
    let line_start = prefix.rfind('\n').map_or(0, |index| index + 1);
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let column = source[line_start..byte_position].encode_utf16().count() + 1;
    (line, column)
}

fn unterminated_string(prefix: &str) -> bool {
    let mut escaped = false;
    let mut quote_count = 0;
    for character in prefix.chars() {
        if escaped {
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '"' {
            quote_count += 1;
        }
    }
    quote_count % 2 == 1
}

fn object_expects_key(prefix: &str) -> bool {
    open_container_is_object(prefix)
}

fn object_expects_colon(prefix: &str) -> bool {
    let Some(last_quote) = prefix.rfind('"') else {
        return false;
    };
    let after_quote = prefix[last_quote + 1..].trim();
    after_quote.is_empty() && prefix[..last_quote].rfind('"').is_some()
}

fn object_expects_separator(prefix: &str) -> bool {
    let Some(last) = prefix.chars().last() else {
        return false;
    };
    open_container(prefix).is_some()
        && matches!(last, '}' | ']' | '"' | '0'..='9' | 'e' | 'E' | 'l')
        && !object_expects_colon(prefix)
        && !prefix.ends_with('{')
        && !prefix.ends_with('[')
}

fn open_container_is_object(prefix: &str) -> bool {
    matches!(open_container(prefix), Some('{'))
}

fn open_container(prefix: &str) -> Option<char> {
    let mut stack = Vec::new();
    let mut in_string = false;
    let mut escaped = false;
    for character in prefix.chars() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => stack.push('{'),
            '[' => stack.push('['),
            '}' | ']' => {
                stack.pop();
            }
            _ => {}
        }
    }
    stack.last().copied()
}

fn looks_like_leading_zero_number(source: &str, position: usize) -> bool {
    source[..position].ends_with('0')
        && source[position..]
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_digit())
}

fn v8_string_error(source: &str, byte_position: usize, is_eof: bool) -> Option<&'static str> {
    let prefix = &source[..byte_position];
    if !unterminated_string(prefix) {
        return None;
    }
    if source[byte_position..]
        .chars()
        .next()
        .is_some_and(char::is_control)
    {
        return Some("Bad control character in string literal in JSON");
    }
    if prefix.ends_with('\\') {
        return Some("Bad escaped character in JSON");
    }
    let unicode_start = prefix.rfind("\\u")?;
    let digits = &prefix[unicode_start + 2..];
    if digits.chars().count() >= 4 {
        return None;
    }
    let next = source[byte_position..].chars().next();
    if is_eof || next.is_some_and(|character| !character.is_ascii_hexdigit()) {
        return Some("Bad Unicode escape in JSON");
    }
    None
}

fn missing_exponent_number(source: &str) -> bool {
    let trimmed = source.trim_end();
    let Some(exponent) = trimmed.rfind(['e', 'E']) else {
        return false;
    };
    let suffix = &trimmed[exponent + 1..];
    !trimmed[..exponent].is_empty() && (suffix.is_empty() || matches!(suffix, "+" | "-"))
}

fn trailing_non_whitespace_after_value(source: &str, position: usize) -> bool {
    let before = source[..position].trim_end();
    matches!(before, "null" | "true" | "false") || before.parse::<f64>().is_ok()
}

impl fmt::Display for CodecEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Frame(frame) => write!(formatter, "native frame ({} bytes)", frame.body_len),
            Self::ProtocolError { message } => formatter.write_str(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{CodecEvent, MAX_FRAME_BYTES, NativeCodec, encode_frame};

    #[test]
    fn preserves_split_header_and_payload_until_complete() {
        let frame = encode_frame(json!({"type": "start"})).expect("frame serializes");
        let mut codec = NativeCodec::new();
        codec.push_bytes(&frame[..2]);
        assert_eq!(codec.next_event(), None);
        codec.push_bytes(&frame[2..5]);
        assert_eq!(codec.next_event(), None);
        codec.push_bytes(&frame[5..]);
        assert_eq!(
            codec.next_event(),
            Some(CodecEvent::Frame(super::InboundFrame {
                value: json!({"type": "start"}).into(),
                body_len: frame.len() - 4,
            }))
        );
    }

    #[test]
    fn decodes_multiple_frames_from_one_read() {
        let first = encode_frame(json!({"type": "start"})).expect("frame serializes");
        let second = encode_frame(json!({"type": "stop"})).expect("frame serializes");
        let mut codec = NativeCodec::new();
        codec.push_bytes(&[first.as_ref(), second.as_ref()].concat());

        assert!(matches!(codec.next_event(), Some(CodecEvent::Frame(_))));
        assert!(matches!(codec.next_event(), Some(CodecEvent::Frame(_))));
        assert_eq!(codec.next_event(), None);
    }

    #[test]
    fn invalid_length_drops_buffered_tail_for_resynchronization() {
        let mut codec = NativeCodec::new();
        let mut source = (MAX_FRAME_BYTES + 1).to_le_bytes().to_vec();
        source.extend_from_slice(b"discarded");
        codec.push_bytes(&source);

        assert_eq!(
            codec.next_event(),
            Some(CodecEvent::ProtocolError {
                message: format!("Invalid message length: {}", MAX_FRAME_BYTES + 1),
            })
        );
        assert!(codec.is_empty());
    }

    #[test]
    fn zero_length_is_recoverable_after_its_buffered_tail_is_dropped() {
        let mut codec = NativeCodec::new();
        codec.push_bytes(&0_u32.to_le_bytes());
        codec.push_bytes(b"discarded");
        assert_eq!(
            codec.next_event(),
            Some(CodecEvent::ProtocolError {
                message: "Invalid message length: 0".to_owned(),
            })
        );
        assert!(codec.is_empty());

        let next = encode_frame(json!({"type": "ping_from_extension"})).expect("frame serializes");
        codec.push_bytes(&next);
        assert!(matches!(codec.next_event(), Some(CodecEvent::Frame(_))));
    }

    #[test]
    fn preserves_escaped_unpaired_surrogates_in_future_message_payloads() {
        let body = br#"{"type":"future_message","payload":{"text":"\ud800","key\udc00":"ok"}}"#;
        let mut codec = NativeCodec::new();
        codec.push_bytes(&(body.len() as u32).to_le_bytes());
        codec.push_bytes(body);

        let Some(CodecEvent::Frame(frame)) = codec.next_event() else {
            panic!("valid escaped unpaired surrogate frame is accepted");
        };
        assert_eq!(
            frame.value.to_json_text(),
            r#"{"type":"future_message","payload":{"text":"\ud800","key\udc00":"ok"}}"#
        );
        let encoded = encode_frame(frame.value).expect("lossless document serializes");
        assert_eq!(&encoded[4..], body);
    }

    #[test]
    fn uses_v8_style_parse_diagnostic_not_serde_diagnostic() {
        let mut codec = NativeCodec::new();
        let body = br#"{]"#;
        codec.push_bytes(&(body.len() as u32).to_le_bytes());
        codec.push_bytes(body);

        assert_eq!(
            codec.next_event(),
            Some(CodecEvent::ProtocolError {
                message: "Failed to parse message: Expected property name or '}' in JSON at position 1 (line 1 column 2)".to_owned(),
            })
        );
    }
}
