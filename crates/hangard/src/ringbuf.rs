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
        self.buf.iter().copied().collect()
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
    fn push_larger_than_cap_keeps_tail() {
        let mut r = RingBuf::new(4);
        r.push(b"0123456789");
        assert_eq!(r.contents(), b"6789");
    }
}
