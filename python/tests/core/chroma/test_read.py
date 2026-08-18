import pytest

from mirage.core.chroma import client, read


@pytest.mark.asyncio
async def test_page_chunks_reads_in_batches(monkeypatch, chroma_accessor,
                                            chroma_collection):
    monkeypatch.setattr(client, "PAGE_CHUNK_BATCH_SIZE", 1)

    chunks = await client.page_chunks(chroma_accessor, "guides/quickstart")

    assert [chunk["document"] for chunk in chunks] == ["first", "second"]
    page_calls = [
        call for call in chroma_collection.get_calls if call.get("where") == {
            "page_slug": "guides/quickstart"
        }
    ]
    assert [call["limit"] for call in page_calls] == [1, 1, 1]
    assert [call["offset"] for call in page_calls] == [0, 1, 2]


@pytest.mark.asyncio
async def test_read_bytes_reassembles_sorted_chunks(chroma_accessor,
                                                    chroma_index,
                                                    quickstart_path):
    data = await read.read_bytes(chroma_accessor, quickstart_path,
                                 chroma_index)

    assert data == b"first\nsecond"


@pytest.mark.asyncio
async def test_read_stream_yields_sorted_chunks(chroma_accessor, chroma_index,
                                                quickstart_path):
    chunks = [
        chunk async for chunk in read.read_stream(
            chroma_accessor, quickstart_path, chroma_index)
    ]

    assert chunks == [b"first", b"\n", b"second"]


@pytest.mark.asyncio
async def test_read_bytes_rejects_directories(chroma_accessor, chroma_index,
                                              knowledge_root):
    with pytest.raises(IsADirectoryError):
        await read.read_bytes(chroma_accessor, knowledge_root, chroma_index)
