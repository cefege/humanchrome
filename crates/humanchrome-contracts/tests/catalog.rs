use humanchrome_contracts::CONTRACT;
use sha2::{Digest, Sha256};

#[test]
fn descriptor_matches_catalog_without_rewriting_pinned_bytes() {
    let descriptor = &CONTRACT["descriptor"];
    let text = descriptor["description"]
        .as_str()
        .expect("descriptor description");
    let names = CONTRACT["catalog"]["knownToolNames"]
        .as_array()
        .expect("ordered names");
    let schemas = CONTRACT["catalog"]["toolSchemas"]
        .as_array()
        .expect("tool schemas");
    assert_eq!(descriptor["toolCount"].as_u64(), Some(schemas.len() as u64));
    assert_eq!(
        descriptor["descriptionLength"].as_u64(),
        Some(text.encode_utf16().count() as u64)
    );
    assert_eq!(
        descriptor["descriptionSha256"].as_str(),
        Some(format!("{:x}", Sha256::digest(text)).as_str())
    );
    assert_eq!(
        &descriptor["toolNames"],
        &CONTRACT["catalog"]["knownToolNames"]
    );
    for name in names {
        assert!(
            schemas.iter().any(|schema| &schema["name"] == name),
            "catalog missing {name}"
        );
    }
}
