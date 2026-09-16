//! Fixed-capacity byte ring buffer used for in-memory scrollback.

use std::collections::VecDeque;

pub struct RingBuf {
    buf: VecDeque<u8>,
    cap: usize,
}

impl RingBuf {
    pub fn new(cap: usize) -> Self {
        Self { buf: VecDeque::with_capacity(cap.min(1 << 16)), cap }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        if bytes.len() >= self.cap {
            self.buf.clear();
            self.buf.extend(&bytes[bytes.len() - self.cap..]);
            return;
        }
        let overflow = (self.buf.len() + bytes.len()).saturating_sub(self.cap);
        if overflow > 0 {
            self.buf.drain(..overflow);
        }
        self.buf.extend(bytes);
    }

    pub fn contents(&self) -> Vec<u8> {
        self.tail(self.buf.len())
    }

    /// Last `n` bytes (or everything if shorter), copied with two memcpys.
    pub fn tail(&self, n: usize) -> Vec<u8> {
        let n = n.min(self.buf.len());
        let (a, b) = self.buf.as_slices();
        let mut out = Vec::with_capacity(n);
        let skip = self.buf.len() - n;
        if skip < a.len() {
            out.extend_from_slice(&a[skip..]);
            out.extend_from_slice(b);
        } else {
            out.extend_from_slice(&b[skip - a.len()..]);
        }
        out
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_last_cap_bytes() {
        let mut r = RingBuf::new(5);
        r.push(b"abc");
        r.push(b"defg");
        assert_eq!(r.contents(), b"cdefg");
    }

    #[test]
    fn tail_returns_last_n_bytes_across_wraparound() {
        let mut r = RingBuf::new(6);
        r.push(b"abcd");
        r.push(b"efgh"); // wraps; buffer = "cdefgh"
        assert_eq!(r.contents(), b"cdefgh");
        assert_eq!(r.tail(3), b"fgh");
        assert_eq!(r.tail(100), b"cdefgh");
        assert_eq!(r.tail(0), b"");
    }

    #[test]
    fn push_larger_than_cap_keeps_tail() {
        let mut r = RingBuf::new(4);
        r.push(b"0123456789");
        assert_eq!(r.contents(), b"6789");
    }
}
