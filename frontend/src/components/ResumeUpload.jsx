import { useCallback, useState } from 'react'
import { useDropzone } from 'react-dropzone'

export default function ResumeUpload({ onFileSelected }) {
  const [selectedFile, setSelectedFile] = useState(null)

  const onDrop = useCallback(
    (acceptedFiles) => {
      const file = acceptedFiles[0]
      if (file) {
        setSelectedFile(file)
        onFileSelected(file)
      }
    },
    [onFileSelected],
  )

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    },
    maxFiles: 1,
  })

  return (
    <div
      {...getRootProps()}
      className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
        isDragActive
          ? 'border-blue-500 bg-blue-50'
          : 'border-gray-300 hover:border-blue-400 bg-gray-50'
      }`}
    >
      <input {...getInputProps()} />
      {selectedFile ? (
        <p className="text-gray-700 font-medium">{selectedFile.name}</p>
      ) : isDragActive ? (
        <p className="text-blue-500 font-medium">Drop your resume here...</p>
      ) : (
        <div>
          <p className="text-gray-500 mb-1">
            Drag and drop your resume here, or click to browse
          </p>
          <p className="text-sm text-gray-400">Accepted formats: PDF, DOCX</p>
        </div>
      )}
    </div>
  )
}
