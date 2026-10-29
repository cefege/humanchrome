//! Native download URL policy and bounded file persistence.

use reqwest::{Client, Url, redirect::Policy};
use serde_json::{Value, json};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::{Path, PathBuf},
};
use tokio::{fs, io::AsyncWriteExt};

const MAX_BYTES: u64 = 100 * 1024 * 1024;

/// Download service with redirects disabled and an explicitly owned upload root.
#[derive(Clone, Debug)]
pub struct FileDownloader {
    temp_dir: PathBuf,
    client: Client,
}

impl FileDownloader {
    /// Create a downloader that never follows a redirect into a different host.
    ///
    /// # Errors
    /// Returns an error if the TLS or HTTP client cannot be initialized.
    pub fn new(temp_dir: PathBuf) -> Result<Self, reqwest::Error> {
        Ok(Self {
            temp_dir,
            client: Client::builder().redirect(Policy::none()).build()?,
        })
    }

    /// Fetch a public HTTP(S) resource to the native upload directory.
    ///
    /// The response body is streamed directly to disk so an unknown or lying
    /// `Content-Length` cannot allocate an unbounded in-memory download.
    ///
    /// # Errors
    /// Returns the URL, DNS policy, HTTP, size, random-source or filesystem error.
    pub async fn download(&self, raw_url: &str, name: Option<&str>) -> anyhow::Result<Value> {
        let url = safe_url(raw_url).await?;
        let mut response = self.client.get(url.clone()).send().await?;
        if response.status().is_redirection() {
            anyhow::bail!("Redirects not allowed (could re-target an internal IP)");
        }
        if !response.status().is_success() {
            anyhow::bail!(
                "Failed to download file: {}",
                response.status().canonical_reason().unwrap_or("")
            );
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_BYTES)
        {
            anyhow::bail!(
                "File too large: {} bytes (cap {MAX_BYTES})",
                response.content_length().unwrap_or(0)
            );
        }
        let filename = match name.filter(|name| !name.is_empty()) {
            Some(name) => name.to_owned(),
            None => generated_name(&url)?,
        };
        // Node path.join keeps an absolute second segment relative to the root.
        let path = self
            .temp_dir
            .join(filename.trim_start_matches(std::path::MAIN_SEPARATOR));
        let mut file = fs::File::create(&path).await?;
        let mut size = 0_u64;
        loop {
            let chunk = match response.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(error) => {
                    drop(file);
                    let _ = fs::remove_file(&path).await;
                    return Err(error.into());
                }
            };
            size = match size.checked_add(u64::try_from(chunk.len())?) {
                Some(size) => size,
                None => {
                    drop(file);
                    let _ = fs::remove_file(&path).await;
                    anyhow::bail!("File too large after download: {MAX_BYTES} bytes");
                }
            };
            if size > MAX_BYTES {
                drop(file);
                let _ = fs::remove_file(&path).await;
                anyhow::bail!("File too large after download: {size} bytes");
            }
            if let Err(error) = file.write_all(&chunk).await {
                drop(file);
                let _ = fs::remove_file(&path).await;
                return Err(error.into());
            }
        }
        if let Err(error) = file.shutdown().await {
            drop(file);
            let _ = fs::remove_file(&path).await;
            return Err(error.into());
        }
        Ok(
            json!({"success":true,"filePath":path.to_string_lossy(),"fileName":filename,"size":size}),
        )
    }
}

async fn safe_url(raw_url: &str) -> anyhow::Result<Url> {
    let url = Url::parse(raw_url).map_err(|_| anyhow::anyhow!("Invalid URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        anyhow::bail!("URL scheme not allowed: {}:", url.scheme());
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("Invalid URL"))?;
    let unbracketed = host.trim_start_matches('[').trim_end_matches(']');
    if unbracketed == "localhost" {
        anyhow::bail!("Loopback URLs are not allowed");
    }
    if let Ok(address) = unbracketed.parse::<IpAddr>() {
        if is_private(address) {
            anyhow::bail!("Private/loopback IP not allowed");
        }
    } else if let Ok(addresses) =
        tokio::net::lookup_host((unbracketed, url.port_or_known_default().unwrap_or(80))).await
        && addresses
            .into_iter()
            .any(|address| is_private(address.ip()))
    {
        anyhow::bail!("Hostname resolves to private/loopback IP");
    }
    Ok(url)
}

fn is_private(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => private_v4(ip),
        IpAddr::V6(ip) => private_v6(ip),
    }
}

fn private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 10
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 169 && b == 254)
        || a == 127
        || a == 0
}

fn private_v6(ip: Ipv6Addr) -> bool {
    let [first, ..] = ip.segments();
    // Preserve the source bridge's IPv4-mapped hexadecimal quirk for parity;
    // it is separately documented as an unfixed SSRF issue in the backlog.
    ip.is_loopback()
        || ip.is_unspecified()
        || (first & 0xfe00) == 0xfc00
        || (first & 0xffc0) == 0xfe80
}

fn generated_name(url: &Url) -> anyhow::Result<String> {
    let basename = url.path().rsplit('/').find(|value| !value.is_empty());
    let size = if basename.is_some() { 4 } else { 8 };
    let mut bytes = [0_u8; 8];
    getrandom::fill(&mut bytes[..size])?;
    let mut suffix = String::with_capacity(size * 2);
    for byte in &bytes[..size] {
        use std::fmt::Write;
        write!(&mut suffix, "{byte:02x}")?;
    }
    let Some(name) = basename else {
        return Ok(format!("upload-{suffix}.bin"));
    };
    let path = Path::new(name);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let stem = name.strip_suffix(&extension).unwrap_or(name);
    Ok(format!("{stem}-{suffix}{extension}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_and_non_http_destinations_are_rejected_before_fetch() {
        for url in [
            "http://127.0.0.1/",
            "http://localhost/",
            "http://[::1]/",
            "http://10.0.0.1/",
            "http://169.254.169.254/",
            "file:///etc/passwd",
        ] {
            assert!(safe_url(url).await.is_err(), "{url}");
        }
    }

    #[test]
    fn recognizes_private_and_public_network_boundaries() {
        assert!(is_private("172.31.2.1".parse().expect("IP")));
        assert!(!is_private("172.32.2.1".parse().expect("IP")));
        assert!(is_private("fe80::1".parse().expect("IP")));
    }
}
